-- Batch 2A: multi-person item assignment and bill-level adjustments.
--
-- * assign_item(item_id, member_ids uuid[]) replaces assign_item(uuid, uuid): the item
--   is split equally among 1..N members (same cent rule as resplit_item_claims and
--   allocateEqual: extra cents to ascending participant id, collate "C").
-- * expense_adjustments: signed bill-level lines (voucher, SST, service charge,
--   rounding) on item_claim / host_assignment expenses. total_cents (the amount
--   paid) = sum(items) + sum(adjustments). Written only by save_expense.
-- * Allocations stay item-level (their sum is the items subtotal). What a person owes
--   for an expense comes from expense_owed_shares: with adjustments, the paid total is
--   split in proportion to each person's item subtotal (allocateProportionally:
--   floor, then largest exact remainder, ties by id code-point order).
-- * Everything that computes "owed" (unresolved check, balances, original-payer
--   transfers, client preview via get_event_owed_shares) uses those owed shares.
--
-- New save_expense keys (SQLSTATE 22023): invalid_adjustment, adjustments_not_allowed,
-- adjustments_need_items, adjustment_mismatch. get_event_owed_shares: not_allowed; 28000 not_authenticated.

-- expense_adjustments ---------------------------------------------------------------
create table public.expense_adjustments (
  id uuid primary key,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  kind text not null check (kind in ('discount', 'tax', 'service', 'rounding', 'other')),
  label text not null check (char_length(label) between 1 and 60),
  amount_cents bigint not null check (amount_cents <> 0),
  sort_order integer not null default 0
);

create index expense_adjustments_expense_id_idx on public.expense_adjustments (expense_id);

alter table public.expense_adjustments enable row level security;
create policy members_read_expense_adjustments on public.expense_adjustments for select using (
  exists(select 1 from public.expenses e where e.id = expense_adjustments.expense_id and public.is_event_member(e.event_id))
);

-- save_expense is the only writer.
revoke all on public.expense_adjustments from anon;
revoke insert, update, delete, truncate, references, trigger on public.expense_adjustments from authenticated;
grant select on public.expense_adjustments to authenticated;

create trigger expense_adjustments_require_open_event before insert or update or delete on public.expense_adjustments
  for each row execute function public.enforce_open_event();

-- Owed shares ----------------------------------------------------------------------------
-- Per participant of one expense. equal/custom, and item expenses without adjustments:
-- the sum of their allocations. Item expenses with adjustments whose items are fully
-- allocated (allocated = total - adjustments): total_cents split in proportion to each
-- person's allocation sum (allocateProportionally; all-zero weights fall back to the
-- equal rule). An unresolved item expense reports the raw allocation sums.
create function public.expense_owed_shares(p_expense uuid)
returns table(participant_user_id uuid, owed_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with x as (
    select e.total_cents::numeric as total,
      e.split_method in ('item_claim', 'host_assignment')
        and exists(select 1 from public.expense_adjustments j where j.expense_id = e.id) as adjusted,
      e.total_cents - coalesce((select sum(j.amount_cents) from public.expense_adjustments j where j.expense_id = e.id), 0) as subtotal
    from public.expenses e
    where e.id = p_expense
  ), w as (
    select a.participant_user_id as uid, sum(a.amount_cents)::numeric as weight
    from public.allocations a
    where a.expense_id = p_expense
    group by a.participant_user_id
  ), m as (
    select x.total, x.adjusted and coalesce((select sum(w.weight) from w), 0) = x.subtotal as proportional,
      coalesce((select sum(w.weight) from w), 0) as wsum,
      (select count(*) from w) as n
    from x
  ), p as (
    select w.uid,
      -- div() is exact integer division; numeric "/" rounds and can land on the next integer.
      case when m.wsum = 0 then div(m.total, m.n) else div(m.total * w.weight, m.wsum) end as base,
      case when m.wsum = 0 then 0 else mod(m.total * w.weight, m.wsum) end as rem
    from w cross join m
    where m.proportional
  ), r as (
    select p.uid, p.base,
      row_number() over (order by p.rem desc, p.uid::text collate "C") as rn,
      (select m.total from m) - sum(p.base) over () as leftover
    from p
  )
  select s.uid, s.owed
  from (
    select r.uid, (r.base + case when r.rn <= r.leftover then 1 else 0 end)::bigint as owed from r
    union all
    select w.uid, w.weight::bigint from w cross join m where not m.proportional
  ) s
  order by s.uid::text collate "C";
$$;

revoke execute on function public.expense_owed_shares(uuid) from public, anon, authenticated;

-- Member-callable: the exact per-expense owed shares the server settles with, so the
-- client preview equals confirm_settlement.
create function public.get_event_owed_shares(event_id uuid)
returns table(expense_id uuid, payer_user_id uuid, participant_user_id uuid, owed_cents bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists(select 1 from public.event_members m
      where m.event_id = get_event_owed_shares.event_id and m.user_id = v_uid) then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  return query
    select x.id, x.payer_user_id, s.participant_user_id, s.owed_cents
    from public.expenses x
    cross join lateral public.expense_owed_shares(x.id) s
    where x.event_id = get_event_owed_shares.event_id
    order by x.id::text collate "C", s.participant_user_id::text collate "C";
end $$;

revoke execute on function public.get_event_owed_shares(uuid) from public, anon;
grant execute on function public.get_event_owed_shares(uuid) to authenticated;

-- Settlement recompute on owed shares ----------------------------------------------------
create or replace function public.compute_settlement_balances(p_event uuid)
returns table(user_id uuid, paid_cents bigint, owed_cents bigint, net_cents bigint)
language sql
stable
set search_path = ''
as $$
  with paid as (
    select x.payer_user_id as uid, sum(x.total_cents) as cents
    from public.expenses x where x.event_id = p_event
    group by x.payer_user_id
  ), owed as (
    select s.participant_user_id as uid, sum(s.owed_cents) as cents
    from public.expenses x
    cross join lateral public.expense_owed_shares(x.id) s
    where x.event_id = p_event
    group by s.participant_user_id
  )
  select coalesce(p.uid, o.uid),
    coalesce(p.cents, 0)::bigint,
    coalesce(o.cents, 0)::bigint,
    (coalesce(p.cents, 0) - coalesce(o.cents, 0))::bigint
  from paid p full join owed o on o.uid = p.uid
  order by coalesce(p.uid, o.uid)::text collate "C";
$$;

create or replace function public.compute_settlement_transfers(p_event uuid, p_method public.settlement_method, p_coordinator uuid)
returns table(payer_user_id uuid, receiver_user_id uuid, amount_cents bigint)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_debtors uuid[];
  v_debts bigint[];
  v_creditors uuid[];
  v_credits bigint[];
  d int := 1;
  c int := 1;
  v_amount bigint;
begin
  if p_method = 'original_payers' then
    return query
      select s.participant_user_id, x.payer_user_id, sum(s.owed_cents)::bigint
      from public.expenses x
      cross join lateral public.expense_owed_shares(x.id) s
      where x.event_id = p_event and s.participant_user_id <> x.payer_user_id and s.owed_cents > 0
      group by s.participant_user_id, x.payer_user_id
      order by s.participant_user_id::text collate "C", x.payer_user_id::text collate "C";
  elsif p_method = 'coordinator' then
    if not exists(select 1 from public.compute_settlement_balances(p_event) b
        where b.user_id = p_coordinator and b.net_cents > 0) then
      raise exception 'coordinator_not_creditor' using errcode = '22023';
    end if;
    return query
      select b.user_id, p_coordinator, -b.net_cents
      from public.compute_settlement_balances(p_event) b
      where b.net_cents < 0
      order by b.user_id::text collate "C";
    return query
      select p_coordinator, b.user_id, b.net_cents
      from public.compute_settlement_balances(p_event) b
      where b.net_cents > 0 and b.user_id <> p_coordinator
      order by b.user_id::text collate "C";
  elsif p_method = 'optimized_direct' then
    select array_agg(b.user_id order by b.net_cents, b.user_id::text collate "C"),
      array_agg(-b.net_cents order by b.net_cents, b.user_id::text collate "C")
    into v_debtors, v_debts
    from public.compute_settlement_balances(p_event) b where b.net_cents < 0;
    select array_agg(b.user_id order by b.net_cents desc, b.user_id::text collate "C"),
      array_agg(b.net_cents order by b.net_cents desc, b.user_id::text collate "C")
    into v_creditors, v_credits
    from public.compute_settlement_balances(p_event) b where b.net_cents > 0;
    while d <= coalesce(cardinality(v_debtors), 0) and c <= coalesce(cardinality(v_creditors), 0) loop
      v_amount := least(v_debts[d], v_credits[c]);
      payer_user_id := v_debtors[d];
      receiver_user_id := v_creditors[c];
      amount_cents := v_amount;
      return next;
      v_debts[d] := v_debts[d] - v_amount;
      v_credits[c] := v_credits[c] - v_amount;
      if v_debts[d] = 0 then d := d + 1; end if;
      if v_credits[c] = 0 then c := c + 1; end if;
    end loop;
  end if;
end $$;

revoke execute on function public.compute_settlement_balances(uuid) from public, anon, authenticated;
revoke execute on function public.compute_settlement_transfers(uuid, public.settlement_method, uuid) from public, anon, authenticated;

-- confirm_settlement: identical to 0008 except the unresolved check, which compares the
-- allocated sum with the items subtotal (total - adjustments).
create or replace function public.confirm_settlement(event_id uuid, method public.settlement_method, coordinator_id uuid,
  expected_revision bigint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event uuid := confirm_settlement.event_id;
  v_state public.event_state;
  v_revision bigint;
  v_role public.event_role;
  v_settlement uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select e.state, e.revision into v_state, v_revision from public.events e where e.id = v_event for update;
  -- Role read AFTER the event lock; a missing event and a non-manager look the same.
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null or v_role not in ('owner', 'cohost') then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if v_state = 'settled' then
    raise exception 'already_settled' using errcode = '22023';
  end if;
  if v_state <> 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  if confirm_settlement.expected_revision is distinct from v_revision then
    raise exception 'stale_revision' using errcode = '40001';
  end if;
  if confirm_settlement.method is null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if confirm_settlement.method = 'coordinator' and confirm_settlement.coordinator_id is null then
    raise exception 'coordinator_required' using errcode = '22023';
  end if;
  if confirm_settlement.method <> 'coordinator' and confirm_settlement.coordinator_id is not null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not exists(select 1 from public.expenses x where x.event_id = v_event) then
    raise exception 'no_expenses' using errcode = '22023';
  end if;
  -- Spec 18: settlement cannot begin while any expense has unallocated (or over-allocated)
  -- cents. Allocations cover the items subtotal, i.e. the paid total minus adjustments.
  -- A positive total with no allocation rows at all is never resolved (nobody would owe it).
  if exists(
    select 1 from public.expenses x
    where x.event_id = v_event
      and (x.total_cents - coalesce((select sum(j.amount_cents) from public.expense_adjustments j where j.expense_id = x.id), 0)
          <> coalesce((select sum(a.amount_cents) from public.allocations a where a.expense_id = x.id), 0)
        or (x.total_cents > 0 and not exists(select 1 from public.allocations a where a.expense_id = x.id)))) then
    raise exception 'unresolved_expenses' using errcode = '22023';
  end if;

  insert into public.settlements (event_id, method, coordinator_user_id, confirmed_by)
  values (v_event, confirm_settlement.method, confirm_settlement.coordinator_id, v_uid)
  returning id into v_settlement;

  insert into public.settlement_balances (settlement_id, user_id, paid_cents, owed_cents, net_cents)
  select v_settlement, b.user_id, b.paid_cents, b.owed_cents, b.net_cents
  from public.compute_settlement_balances(v_event) b;

  -- Raises coordinator_not_creditor (rolling everything back) for a bad coordinator.
  insert into public.settlement_transfers (settlement_id, payer_user_id, receiver_user_id, amount_cents, ordinal)
  select v_settlement, t.payer_user_id, t.receiver_user_id, t.amount_cents, t.ordinal
  from public.compute_settlement_transfers(v_event, confirm_settlement.method, confirm_settlement.coordinator_id)
    with ordinality as t(payer_user_id, receiver_user_id, amount_cents, ordinal);

  -- From here the open-event trigger makes the event's expense data read-only.
  update public.events e set state = 'settled', settled_at = now(), revision = e.revision + 1 where e.id = v_event;

  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, 'settlement_confirmed',
    jsonb_build_object('settlement_id', v_settlement, 'method', confirm_settlement.method));

  -- A settlement with no transfers is already fully paid.
  perform public.schedule_payment_details_cleanup(v_event);

  return v_settlement;
end $$;

revoke execute on function public.confirm_settlement(uuid, public.settlement_method, uuid, bigint) from public, anon;
grant execute on function public.confirm_settlement(uuid, public.settlement_method, uuid, bigint) to authenticated;

-- assign_item (multi-member) ---------------------------------------------------------------
-- The expense creator (own expense) or an owner/co-host gives the item to 1..N distinct
-- members, replacing its allocations with equal shares. Allowed after claiming is closed.
drop function public.assign_item(uuid, uuid);

create function public.assign_item(item_id uuid, member_ids uuid[])
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
  v_members jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  -- Locks the event (then the expense) and re-checks membership after the lock.
  v_expense := public.lock_item_expense(assign_item.item_id, v_uid);
  select m.role into v_role from public.event_members m where m.event_id = v_expense.event_id and m.user_id = v_uid;
  if v_role not in ('owner', 'cohost') and v_expense.creator_user_id <> v_uid then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if coalesce(cardinality(assign_item.member_ids), 0) = 0
    or array_position(assign_item.member_ids, null) is not null
    or (select count(distinct u) from unnest(assign_item.member_ids) as u) <> cardinality(assign_item.member_ids) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if exists(select 1 from unnest(assign_item.member_ids) as u
      where not exists(select 1 from public.event_members m where m.event_id = v_expense.event_id and m.user_id = u)) then
    raise exception 'not_member' using errcode = '22023';
  end if;

  delete from public.allocations a where a.item_id = assign_item.item_id;
  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
  select v_expense.id, i.id, s.uid,
    i.total_cents / s.n + case when s.rn <= i.total_cents % s.n then 1 else 0 end,
    case v_role when 'owner' then 'owner' when 'cohost' then 'cohost' else 'expense_creator' end
  from public.expense_items i
  cross join (
    select u as uid, row_number() over (order by u::text collate "C") as rn, count(*) over () as n
    from unnest(assign_item.member_ids) as u
  ) s
  where i.id = assign_item.item_id;

  select jsonb_agg(u order by u::text collate "C") into v_members from unnest(assign_item.member_ids) as u;

  update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_expense.event_id, v_uid, 'item_assigned',
    jsonb_build_object('expense_id', v_expense.id, 'item_id', assign_item.item_id, 'member_ids', v_members));
end $$;

revoke execute on function public.assign_item(uuid, uuid[]) from public, anon;
grant execute on function public.assign_item(uuid, uuid[]) to authenticated;

-- save_expense: adjustments + multi-member item shares ------------------------------------
-- Same as 0008 plus:
--   payload.adjustments: [{ id, kind, label, amount_cents, sort_order }] (default []),
--     replaced like items; only on item_claim / host_assignment
--     (adjustments_not_allowed otherwise); total_cents = items + adjustments
--     (adjustment_mismatch; item_total_mismatch still applies without adjustments).
--   item allocations: an item may carry several shares, which must be the equal split
--     of the item over its assignees (invalid_allocation otherwise, which also rejects a
--     partially allocated item).
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
  v_adjs jsonb;
  v_role public.event_role;
  v_state public.event_state;
  v_manager boolean;
  v_existing public.expenses;
  v_is_update boolean;
  v_count bigint;
  v_distinct bigint;
  v_sum numeric;
  v_ok boolean;
  v_adj_count bigint;
  v_adj_sum numeric;
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

  -- Lock the event row so concurrent saves for the event serialize, then read the
  -- caller's role (a demotion that committed while waiting must not be bypassed).
  -- Non-members get not_event_member before any state is revealed.
  select e.state into v_state from public.events e where e.id = v_event for update;
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null then
    raise exception 'not_event_member' using errcode = '22023';
  end if;
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
  v_adjs := coalesce(payload->'adjustments', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'invalid_item' using errcode = '22023';
  end if;
  if jsonb_typeof(v_allocs) <> 'array' then
    raise exception 'invalid_allocation' using errcode = '22023';
  end if;
  if jsonb_typeof(v_adjs) <> 'array' then
    raise exception 'invalid_adjustment' using errcode = '22023';
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

  -- Adjustments: id, known kind, 1-60 char label, non-zero signed integer cents (JSON
  -- numbers), unique ids (also across other expenses).
  if exists(
    select 1 from jsonb_array_elements(v_adjs) as e(v)
    where jsonb_typeof(e.v) is distinct from 'object'
      or jsonb_typeof(e.v->'id') is distinct from 'string'
      or jsonb_typeof(e.v->'kind') is distinct from 'string'
      or jsonb_typeof(e.v->'label') is distinct from 'string'
      or jsonb_typeof(e.v->'amount_cents') is distinct from 'number'
      or coalesce(jsonb_typeof(e.v->'sort_order'), 'number') <> 'number') then
    raise exception 'invalid_adjustment' using errcode = '22023';
  end if;
  begin
    select count(*), count(distinct t.id), coalesce(sum(t.amount_cents), 0),
      bool_and(coalesce(
        t.id is not null
        and t.kind in ('discount', 'tax', 'service', 'rounding', 'other')
        and char_length(btrim(t.label)) between 1 and 60
        and t.amount_cents = trunc(t.amount_cents) and t.amount_cents <> 0
        and t.amount_cents between -9007199254740991 and 9007199254740991
        and coalesce(t.sort_order, 0) = trunc(coalesce(t.sort_order, 0))
        and coalesce(t.sort_order, 0) between -2147483648 and 2147483647, false))
    into v_adj_count, v_distinct, v_adj_sum, v_ok
    from jsonb_to_recordset(v_adjs) as t(id uuid, kind text, label text, amount_cents numeric, sort_order numeric);
  exception when others then
    raise exception 'invalid_adjustment' using errcode = '22023';
  end;
  if not v_ok then
    raise exception 'invalid_adjustment' using errcode = '22023';
  end if;
  if v_distinct <> v_adj_count or exists(
    select 1 from jsonb_to_recordset(v_adjs) as t(id uuid)
    join public.expense_adjustments j on j.id = t.id
    where j.expense_id <> v_id) then
    raise exception 'invalid_adjustment' using errcode = '22023';
  end if;

  if v_method in ('equal', 'custom') then
    if v_count > 0 then
      raise exception 'items_not_allowed' using errcode = '22023';
    end if;
    if v_adj_count > 0 then
      raise exception 'adjustments_not_allowed' using errcode = '22023';
    end if;
  else
    if v_count = 0 then
      raise exception 'items_required' using errcode = '22023';
    end if;
    if v_adj_count = 0 and v_sum <> v_total then
      raise exception 'item_total_mismatch' using errcode = '22023';
    end if;
    -- Adjustments are spread over item subtotals, so they need items that cost something.
    if v_adj_count > 0 and v_sum = 0 then
      raise exception 'adjustments_need_items' using errcode = '22023';
    end if;
    if v_adj_count > 0 and v_sum + v_adj_sum <> v_total then
      raise exception 'adjustment_mismatch' using errcode = '22023';
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
    -- item_claim / host_assignment: items may stay unallocated here because they are
    -- claimed later; the full allocation rule is enforced at settlement.
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
    -- An allocated item is split equally among its assignees (allocateEqual / assign_item:
    -- extra cents to ascending participant id, byte order).
    if exists(
      select 1
      from (
        select a.amount_cents, t.total_cents,
          row_number() over (partition by a.item_id order by a.participant_user_id::text collate "C") as rn,
          count(*) over (partition by a.item_id) as n
        from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric)
        join jsonb_to_recordset(v_items) as t(id uuid, total_cents numeric) on t.id = a.item_id
      ) s
      where s.amount_cents <> div(s.total_cents, s.n) + case when s.rn <= mod(s.total_cents, s.n) then 1 else 0 end) then
      raise exception 'invalid_allocation' using errcode = '22023';
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
  delete from public.expense_adjustments j where j.expense_id = v_id;

  insert into public.expense_items (id, expense_id, description, quantity, total_cents, sort_order)
  select t.id, v_id, btrim(t.description), coalesce(t.quantity, 1), t.total_cents, coalesce(t.sort_order, 0)
  from jsonb_to_recordset(v_items) as t(id uuid, description text, quantity numeric, total_cents numeric, sort_order numeric);

  insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents, sort_order)
  select t.id, v_id, t.kind, btrim(t.label), t.amount_cents, coalesce(t.sort_order, 0)
  from jsonb_to_recordset(v_adjs) as t(id uuid, kind text, label text, amount_cents numeric, sort_order numeric);

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

  -- Redacted: only the expense id, never amounts, descriptions, adjustments or participants.
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, case when v_is_update then 'expense_updated' else 'expense_created' end,
    jsonb_build_object('expense_id', v_id));

  return v_id;
end $$;

revoke execute on function public.save_expense(jsonb) from public, anon;
grant execute on function public.save_expense(jsonb) to authenticated;
