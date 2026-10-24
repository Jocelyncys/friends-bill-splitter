-- Claiming, assignment and role RPCs (Task 7a), self-claims surviving save_expense,
-- and the realtime publication.
--
-- Every RPC is security definer with an empty search_path, locks the event row,
-- requires the event to be 'open', bumps events.revision and writes a redacted
-- activity row (ids only) when it changes something. A call that changes nothing
-- (repeat claim/unclaim, same role, same closed flag) returns without writing.
-- Errors: SQLSTATE 22023 with a machine key (item_not_found, event_not_open,
-- not_claimable, claiming_closed, not_allowed, not_member, invalid_role_change,
-- invalid_payload; save_expense adds item_has_claims); 28000 not_authenticated.
--
-- Item allocation model: an item_claim item's allocations are either all
-- self-claims (shared equally among the claimers, see resplit_item_claims) or a
-- manager/creator assignment (assign_item replaces everything). Self-claiming an
-- assigned item is rejected as not_claimable.

-- Internal helpers (not callable by clients) -----------------------------------

-- Re-splits an item's total equally across all of its allocations. Extra cents go
-- to the participants in ascending participant_user_id text order, matching the
-- client's allocateEqual.
create function public.resplit_item_claims(p_item uuid)
returns void
language sql
set search_path = ''
as $$
  with c as (
    select a.id,
      row_number() over (order by a.participant_user_id::text) as rn,
      count(*) over () as n
    from public.allocations a
    where a.item_id = p_item
  )
  update public.allocations a
  set amount_cents = i.total_cents / c.n + case when c.rn <= i.total_cents % c.n then 1 else 0 end
  from c, public.expense_items i
  where a.id = c.id and i.id = p_item;
$$;

-- Resolves an item to its expense for a member caller: hides items of other
-- events (item_not_found), locks the event row, requires 'open', then locks and
-- returns the expense row.
create function public.lock_item_expense(p_item uuid, p_uid uuid)
returns public.expenses
language plpgsql
set search_path = ''
as $$
declare
  v_event uuid;
  v_state public.event_state;
  v_expense public.expenses;
begin
  select x.event_id into v_event
  from public.expense_items i join public.expenses x on x.id = i.expense_id
  where i.id = p_item;
  if v_event is null
    or not exists(select 1 from public.event_members m where m.event_id = v_event and m.user_id = p_uid) then
    raise exception 'item_not_found' using errcode = '22023';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  if v_state is distinct from 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  select x.* into v_expense
  from public.expense_items i join public.expenses x on x.id = i.expense_id
  where i.id = p_item
  for update of x;
  if not found then
    raise exception 'item_not_found' using errcode = '22023';
  end if;
  return v_expense;
end $$;

revoke execute on function public.resplit_item_claims(uuid) from public, anon, authenticated;
revoke execute on function public.lock_item_expense(uuid, uuid) from public, anon, authenticated;

-- claim_item / unclaim_item -----------------------------------------------------
create function public.claim_item(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_expense public.expenses;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_expense := public.lock_item_expense(claim_item.item_id, v_uid);
  if v_expense.split_method <> 'item_claim' then
    raise exception 'not_claimable' using errcode = '22023';
  end if;
  if v_expense.claiming_closed then
    raise exception 'claiming_closed' using errcode = '22023';
  end if;
  if exists(select 1 from public.allocations a where a.item_id = claim_item.item_id and a.source <> 'self_claim') then
    raise exception 'not_claimable' using errcode = '22023';
  end if;

  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
  values (v_expense.id, claim_item.item_id, v_uid, 0, 'self_claim')
  on conflict do nothing;
  if not found then
    return; -- already claimed
  end if;
  perform public.resplit_item_claims(claim_item.item_id);

  update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_expense.event_id, v_uid, 'item_claimed',
    jsonb_build_object('expense_id', v_expense.id, 'item_id', claim_item.item_id));
end $$;

create function public.unclaim_item(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_expense public.expenses;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_expense := public.lock_item_expense(unclaim_item.item_id, v_uid);
  if v_expense.split_method <> 'item_claim' then
    raise exception 'not_claimable' using errcode = '22023';
  end if;
  if v_expense.claiming_closed then
    raise exception 'claiming_closed' using errcode = '22023';
  end if;
  if exists(select 1 from public.allocations a where a.item_id = unclaim_item.item_id and a.source <> 'self_claim') then
    raise exception 'not_claimable' using errcode = '22023';
  end if;

  delete from public.allocations a
  where a.item_id = unclaim_item.item_id and a.participant_user_id = v_uid and a.source = 'self_claim';
  if not found then
    return; -- nothing to unclaim
  end if;
  perform public.resplit_item_claims(unclaim_item.item_id);

  update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_expense.event_id, v_uid, 'item_unclaimed',
    jsonb_build_object('expense_id', v_expense.id, 'item_id', unclaim_item.item_id));
end $$;

-- assign_item ---------------------------------------------------------------------
-- The expense creator (own expense) or an owner/co-host gives the whole item to one
-- member, replacing its allocations. Allowed after claiming is closed.
create function public.assign_item(item_id uuid, member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_expense public.expenses;
  v_role public.event_role;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_expense := public.lock_item_expense(assign_item.item_id, v_uid);
  select m.role into v_role from public.event_members m where m.event_id = v_expense.event_id and m.user_id = v_uid;
  if v_role not in ('owner', 'cohost') and v_expense.creator_user_id <> v_uid then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if not exists(select 1 from public.event_members m
      where m.event_id = v_expense.event_id and m.user_id = assign_item.member_id) then
    raise exception 'not_member' using errcode = '22023';
  end if;

  delete from public.allocations a where a.item_id = assign_item.item_id;
  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
  select v_expense.id, i.id, assign_item.member_id, i.total_cents,
    case v_role when 'owner' then 'owner' when 'cohost' then 'cohost' else 'expense_creator' end
  from public.expense_items i
  where i.id = assign_item.item_id;

  update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_expense.event_id, v_uid, 'item_assigned',
    jsonb_build_object('expense_id', v_expense.id, 'item_id', assign_item.item_id, 'member_id', assign_item.member_id));
end $$;

-- set_claiming_closed ---------------------------------------------------------------
-- Claiming is closed per expense, by its creator or an owner/co-host.
create function public.set_claiming_closed(expense_id uuid, closed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event uuid;
  v_role public.event_role;
  v_state public.event_state;
  v_expense public.expenses;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if set_claiming_closed.closed is null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  -- A missing expense and a non-member caller look the same.
  select x.event_id into v_event from public.expenses x where x.id = set_claiming_closed.expense_id;
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  if v_state is distinct from 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  select * into v_expense from public.expenses x where x.id = set_claiming_closed.expense_id for update;
  if not found or (v_role not in ('owner', 'cohost') and v_expense.creator_user_id <> v_uid) then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if v_expense.claiming_closed = set_claiming_closed.closed then
    return;
  end if;

  update public.expenses x set claiming_closed = set_claiming_closed.closed where x.id = v_expense.id;

  update public.events e set revision = e.revision + 1 where e.id = v_event;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, case when set_claiming_closed.closed then 'claiming_closed' else 'claiming_reopened' end,
    jsonb_build_object('expense_id', v_expense.id));
end $$;

-- set_member_role ---------------------------------------------------------------------
-- Owner only; participant <-> cohost only; the owner row never changes. This is the
-- only way to change a role (clients have no UPDATE on event_members.role).
create function public.set_member_role(event_id uuid, member_id uuid, role public.event_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_caller public.event_role;
  v_state public.event_state;
  v_target public.event_role;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select m.role into v_caller from public.event_members m
  where m.event_id = set_member_role.event_id and m.user_id = v_uid;
  if v_caller is distinct from 'owner' then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  select e.state into v_state from public.events e where e.id = set_member_role.event_id for update;
  if v_state is distinct from 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  select m.role into v_target from public.event_members m
  where m.event_id = set_member_role.event_id and m.user_id = set_member_role.member_id
  for update;
  if not found then
    raise exception 'not_member' using errcode = '22023';
  end if;
  if v_target = 'owner' or set_member_role.role is null or set_member_role.role not in ('participant', 'cohost') then
    raise exception 'invalid_role_change' using errcode = '22023';
  end if;
  if v_target = set_member_role.role then
    return;
  end if;

  update public.event_members m set role = set_member_role.role
  where m.event_id = set_member_role.event_id and m.user_id = set_member_role.member_id;

  update public.events e set revision = e.revision + 1 where e.id = set_member_role.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (set_member_role.event_id, v_uid, 'member_role_changed',
    jsonb_build_object('member_id', set_member_role.member_id));
end $$;

revoke execute on function public.claim_item(uuid) from public, anon;
revoke execute on function public.unclaim_item(uuid) from public, anon;
revoke execute on function public.assign_item(uuid, uuid) from public, anon;
revoke execute on function public.set_claiming_closed(uuid, boolean) from public, anon;
revoke execute on function public.set_member_role(uuid, uuid, public.event_role) from public, anon;
grant execute on function public.claim_item(uuid) to authenticated;
grant execute on function public.unclaim_item(uuid) to authenticated;
grant execute on function public.assign_item(uuid, uuid) to authenticated;
grant execute on function public.set_claiming_closed(uuid, boolean) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, public.event_role) to authenticated;

-- save_expense: keep self-claims across edits ---------------------------------------
-- Replaced here (not by editing the applied 0005 migration). Only change: when an
-- existing item_claim expense is re-saved as item_claim, self-claims on items that
-- keep their id are restored after the item rewrite and re-split to the item's new
-- total; claims on removed items go with them. A payload that also allocates such
-- an item is rejected with item_has_claims.
create or replace function public.save_expense(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_event uuid;
  v_payer uuid;
  v_description text;
  v_category text;
  v_date date;
  v_num numeric;
  v_total bigint;
  v_method public.split_method;
  v_items jsonb;
  v_allocs jsonb;
  v_role public.event_role;
  v_state public.event_state;
  v_manager boolean;
  v_existing public.expenses;
  v_is_update boolean;
  v_count bigint;
  v_distinct bigint;
  v_sum numeric;
  v_ok boolean;
  v_source text;
  v_claims jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if jsonb_typeof(save_expense.payload) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  begin
    v_id := (payload->>'id')::uuid;
    v_event := (payload->>'event_id')::uuid;
    v_payer := (payload->>'payer_user_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'invalid_payload' using errcode = '22023';
  end;
  if v_id is null or v_event is null or v_payer is null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  -- Membership first (do not reveal other events), then lock the event row so
  -- concurrent saves for the event serialize.
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null then
    raise exception 'not_event_member' using errcode = '22023';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  if v_state is distinct from 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  v_manager := v_role in ('owner', 'cohost');

  select * into v_existing from public.expenses x where x.id = v_id for update;
  v_is_update := found;
  if v_is_update then
    if v_existing.event_id <> v_event then
      raise exception 'event_mismatch' using errcode = '22023';
    end if;
    if not v_manager and v_existing.creator_user_id <> v_uid then
      raise exception 'not_allowed' using errcode = '22023';
    end if;
  end if;

  if not v_manager and v_payer <> v_uid then
    raise exception 'payer_not_allowed' using errcode = '22023';
  end if;
  if not exists(select 1 from public.event_members m where m.event_id = v_event and m.user_id = v_payer) then
    raise exception 'payer_not_member' using errcode = '22023';
  end if;

  v_description := btrim(payload->>'description');
  if v_description is null or char_length(v_description) not between 1 and 120 then
    raise exception 'invalid_description' using errcode = '22023';
  end if;
  v_category := coalesce(nullif(btrim(payload->>'category'), ''), 'other');
  if char_length(v_category) > 40 then
    raise exception 'invalid_category' using errcode = '22023';
  end if;
  if coalesce(payload->>'expense_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid_date' using errcode = '22023';
  end if;
  begin
    v_date := (payload->>'expense_date')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    raise exception 'invalid_date' using errcode = '22023';
  end;

  -- Positive integer cents within the JS safe-integer range.
  v_num := case when jsonb_typeof(payload->'total_cents') = 'number' then (payload->'total_cents')::numeric end;
  if v_num is null or v_num <> trunc(v_num) or v_num not between 1 and 9007199254740991 then
    raise exception 'invalid_total' using errcode = '22023';
  end if;
  v_total := v_num;

  begin
    v_method := (payload->>'split_method')::public.split_method;
  exception when invalid_text_representation then
    raise exception 'invalid_split_method' using errcode = '22023';
  end;
  if v_method is null then
    raise exception 'invalid_split_method' using errcode = '22023';
  end if;

  v_items := coalesce(payload->'items', '[]'::jsonb);
  v_allocs := coalesce(payload->'allocations', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'invalid_item' using errcode = '22023';
  end if;
  if jsonb_typeof(v_allocs) <> 'array' then
    raise exception 'invalid_allocation' using errcode = '22023';
  end if;

  -- Items: well-formed, integer cents, unique ids (also across other expenses).
  -- Numeric fields must be JSON numbers (not numeric strings), like total_cents.
  if exists(
    select 1 from jsonb_array_elements(v_items) as e(v)
    where jsonb_typeof(e.v) is distinct from 'object'
      or jsonb_typeof(e.v->'total_cents') is distinct from 'number'
      or coalesce(jsonb_typeof(e.v->'quantity'), 'number') <> 'number'
      or coalesce(jsonb_typeof(e.v->'sort_order'), 'number') <> 'number') then
    raise exception 'invalid_item' using errcode = '22023';
  end if;
  begin
    select count(*), count(distinct t.id), coalesce(sum(t.total_cents), 0),
      bool_and(coalesce(
        t.id is not null
        and char_length(btrim(coalesce(t.description, ''))) between 1 and 120
        and coalesce(t.quantity, 1) = trunc(coalesce(t.quantity, 1)) and coalesce(t.quantity, 1) between 1 and 2147483647
        and t.total_cents is not null
        and t.total_cents = trunc(t.total_cents) and t.total_cents between 0 and 9007199254740991
        and coalesce(t.sort_order, 0) = trunc(coalesce(t.sort_order, 0))
        and coalesce(t.sort_order, 0) between -2147483648 and 2147483647, false))
    into v_count, v_distinct, v_sum, v_ok
    from jsonb_to_recordset(v_items) as t(id uuid, description text, quantity numeric, total_cents numeric, sort_order numeric);
  exception when others then
    raise exception 'invalid_item' using errcode = '22023';
  end;
  if not v_ok then
    raise exception 'invalid_item' using errcode = '22023';
  end if;
  if v_distinct <> v_count or exists(
    select 1 from jsonb_to_recordset(v_items) as t(id uuid)
    join public.expense_items i on i.id = t.id
    where i.expense_id <> v_id) then
    raise exception 'duplicate_item_id' using errcode = '22023';
  end if;

  if v_method in ('equal', 'custom') then
    if v_count > 0 then
      raise exception 'items_not_allowed' using errcode = '22023';
    end if;
  else
    if v_count = 0 then
      raise exception 'items_required' using errcode = '22023';
    end if;
    if v_sum <> v_total then
      raise exception 'item_total_mismatch' using errcode = '22023';
    end if;
  end if;

  -- Allocations: non-negative integer cents (JSON numbers), one row per (item, participant).
  if exists(
    select 1 from jsonb_array_elements(v_allocs) as e(v)
    where jsonb_typeof(e.v) is distinct from 'object'
      or jsonb_typeof(e.v->'amount_cents') is distinct from 'number'
      or jsonb_typeof(e.v->'participant_user_id') is distinct from 'string'
      or coalesce(jsonb_typeof(e.v->'item_id'), 'null') not in ('null', 'string')) then
    raise exception 'invalid_allocation' using errcode = '22023';
  end if;
  begin
    select count(*), count(distinct coalesce(a.item_id::text, '') || ':' || a.participant_user_id::text),
      coalesce(sum(a.amount_cents), 0),
      bool_and(coalesce(
        a.participant_user_id is not null
        and a.amount_cents is not null
        and a.amount_cents = trunc(a.amount_cents) and a.amount_cents between 0 and 9007199254740991, false))
    into v_count, v_distinct, v_sum, v_ok
    from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric);
  exception when others then
    raise exception 'invalid_allocation' using errcode = '22023';
  end;
  if not v_ok then
    raise exception 'invalid_allocation' using errcode = '22023';
  end if;
  if v_distinct <> v_count then
    raise exception 'duplicate_allocation' using errcode = '22023';
  end if;
  if exists(
    select 1 from jsonb_to_recordset(v_allocs) as a(participant_user_id uuid)
    where not exists(select 1 from public.event_members m
      where m.event_id = v_event and m.user_id = a.participant_user_id)) then
    raise exception 'not_member' using errcode = '22023';
  end if;

  if v_method in ('equal', 'custom') then
    if exists(select 1 from jsonb_to_recordset(v_allocs) as a(item_id uuid) where a.item_id is not null) then
      raise exception 'invalid_allocation' using errcode = '22023';
    end if;
    -- Also rejects an empty allocation list, since the total is positive.
    if v_sum <> v_total then
      raise exception 'allocation_mismatch' using errcode = '22023';
    end if;
  else
    -- item_claim / host_assignment: allocations may be partial here because items are
    -- claimed later; the full sum(allocations) = total rule is enforced at settlement.
    if exists(
      select 1 from jsonb_to_recordset(v_allocs) as a(item_id uuid)
      where a.item_id is null
        or a.item_id not in (select t.id from jsonb_to_recordset(v_items) as t(id uuid))) then
      raise exception 'invalid_allocation' using errcode = '22023';
    end if;
    if exists(
      select 1
      from jsonb_to_recordset(v_items) as t(id uuid, total_cents numeric)
      join jsonb_to_recordset(v_allocs) as a(item_id uuid, amount_cents numeric) on a.item_id = t.id
      group by t.id, t.total_cents
      having sum(a.amount_cents) > t.total_cents) then
      raise exception 'allocation_exceeds_item' using errcode = '22023';
    end if;
  end if;

  -- Self-claims (Task 7) survive a re-save for items that keep their id.
  if v_is_update and v_existing.split_method = 'item_claim' and v_method = 'item_claim' then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', a.item_id, 'participant_user_id', a.participant_user_id)), '[]'::jsonb)
    into v_claims
    from public.allocations a
    where a.expense_id = v_id and a.source = 'self_claim'
      and a.item_id in (select t.id from jsonb_to_recordset(v_items) as t(id uuid));
    if exists(
      select 1 from jsonb_to_recordset(v_claims) as c(item_id uuid)
      join jsonb_to_recordset(v_allocs) as a(item_id uuid) on a.item_id = c.item_id) then
      raise exception 'item_has_claims' using errcode = '22023';
    end if;
  end if;

  -- Writes ------------------------------------------------------------------------
  if v_is_update then
    update public.expenses x
    set payer_user_id = v_payer, description = v_description, category = v_category,
        expense_date = v_date, total_cents = v_total, split_method = v_method
    where x.id = v_id;
  else
    insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, category,
      expense_date, total_cents, split_method)
    values (v_id, v_event, v_uid, v_payer, v_description, v_category, v_date, v_total, v_method);
  end if;

  delete from public.allocations a where a.expense_id = v_id;
  delete from public.expense_items i where i.expense_id = v_id;

  insert into public.expense_items (id, expense_id, description, quantity, total_cents, sort_order)
  select t.id, v_id, btrim(t.description), coalesce(t.quantity, 1), t.total_cents, coalesce(t.sort_order, 0)
  from jsonb_to_recordset(v_items) as t(id uuid, description text, quantity numeric, total_cents numeric, sort_order numeric);

  -- The source is decided by the server from the method and the caller's role.
  v_source := case
    when v_method in ('equal', 'custom') then 'calculated'
    when v_role = 'owner' then 'owner'
    when v_role = 'cohost' then 'cohost'
    else 'expense_creator'
  end;
  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
  select v_id, a.item_id, a.participant_user_id, a.amount_cents, v_source
  from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric);

  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
  select v_id, c.item_id, c.participant_user_id, 0, 'self_claim'
  from jsonb_to_recordset(v_claims) as c(item_id uuid, participant_user_id uuid);
  perform public.resplit_item_claims(c.item_id)
  from (select distinct r.item_id from jsonb_to_recordset(v_claims) as r(item_id uuid)) as c;

  update public.events e set revision = e.revision + 1 where e.id = v_event;

  -- Redacted: only the expense id, never amounts, descriptions or participants.
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, case when v_is_update then 'expense_updated' else 'expense_created' end,
    jsonb_build_object('expense_id', v_id));

  return v_id;
end $$;

revoke execute on function public.save_expense(jsonb) from public, anon;
grant execute on function public.save_expense(jsonb) to authenticated;

-- Realtime ------------------------------------------------------------------------------
-- postgres_changes respects RLS, so members only receive rows they can select.
do $$
declare
  t text;
begin
  if not exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['events', 'event_members', 'expenses', 'expense_items', 'allocations'] loop
    if not exists(select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
