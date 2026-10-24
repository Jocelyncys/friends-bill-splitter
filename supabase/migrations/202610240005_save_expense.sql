-- Atomic expense saving (save_expense), an open-event guard trigger on expense
-- data, payer changes only via the RPC, and create_event with an owner name.
--
-- save_expense raises SQLSTATE 22023 with a stable machine key as the message
-- (invalid_payload, not_event_member, event_not_open, event_mismatch, not_allowed,
-- payer_not_allowed, payer_not_member, invalid_description, invalid_category,
-- invalid_date, invalid_total, invalid_split_method, invalid_item, duplicate_item_id,
-- items_not_allowed, items_required, item_total_mismatch, invalid_allocation,
-- duplicate_allocation, not_member, allocation_mismatch, allocation_exceeds_item);
-- 28000 not_authenticated. The client maps these keys to form errors.

-- Payer changes happen only through save_expense.
revoke update (payer_user_id) on public.expenses from authenticated;

-- Open-event guard ---------------------------------------------------------------
-- Rejects any insert/update/delete of an expense, item or allocation whose parent
-- event is not 'open'. A missing parent means it is being removed by
-- `on delete cascade` (or the FK check will reject the row), so it is allowed.
create function public.enforce_open_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb[] := array[]::jsonb[];
  v_row jsonb;
  v_state public.event_state;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_rows := v_rows || to_jsonb(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_rows := v_rows || to_jsonb(new);
  end if;

  foreach v_row in array v_rows loop
    if tg_table_name = 'expenses' then
      select e.state into v_state from public.events e where e.id = (v_row->>'event_id')::uuid;
    else
      select e.state into v_state
      from public.expenses x join public.events e on e.id = x.event_id
      where x.id = (v_row->>'expense_id')::uuid;
    end if;
    if found and v_state <> 'open' then
      raise exception 'event_not_open' using errcode = '22023';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

revoke execute on function public.enforce_open_event() from public, anon, authenticated;

create trigger expenses_require_open_event before insert or update or delete on public.expenses
  for each row execute function public.enforce_open_event();
create trigger expense_items_require_open_event before insert or update or delete on public.expense_items
  for each row execute function public.enforce_open_event();
create trigger allocations_require_open_event before insert or update or delete on public.allocations
  for each row execute function public.enforce_open_event();

-- save_expense -------------------------------------------------------------------
-- payload: { id, event_id, payer_user_id, description, category, expense_date,
--   total_cents, split_method, items: [{ id, description, quantity, total_cents, sort_order }],
--   allocations: [{ item_id, participant_user_id, amount_cents }] }
-- Inserts or updates by the client-provided id and replaces that expense's items and
-- allocations, so retrying the same payload is idempotent.
create function public.save_expense(payload jsonb)
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
  begin
    select count(*), count(distinct t.id), coalesce(sum(t.total_cents), 0),
      coalesce(bool_and(
        t.id is not null
        and char_length(btrim(coalesce(t.description, ''))) between 1 and 120
        and coalesce(t.quantity, 1) = trunc(coalesce(t.quantity, 1)) and coalesce(t.quantity, 1) between 1 and 2147483647
        and t.total_cents = trunc(t.total_cents) and t.total_cents between 0 and 9007199254740991
        and coalesce(t.sort_order, 0) = trunc(coalesce(t.sort_order, 0))
        and coalesce(t.sort_order, 0) between -2147483648 and 2147483647), true)
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

  -- Allocations: non-negative integer cents, one row per (item, participant).
  begin
    select count(*), count(distinct coalesce(a.item_id::text, '') || ':' || a.participant_user_id::text),
      coalesce(sum(a.amount_cents), 0),
      coalesce(bool_and(
        a.participant_user_id is not null
        and a.amount_cents = trunc(a.amount_cents) and a.amount_cents between 0 and 9007199254740991), true)
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

  update public.events e set revision = e.revision + 1 where e.id = v_event;

  -- Redacted: only the expense id, never amounts, descriptions or participants.
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, case when v_is_update then 'expense_updated' else 'expense_created' end,
    jsonb_build_object('expense_id', v_id));

  return v_id;
end $$;

revoke execute on function public.save_expense(jsonb) from public, anon;
grant execute on function public.save_expense(jsonb) to authenticated;

-- create_event now names the owner's member row ---------------------------------
drop function public.create_event(text, public.event_mode, text);

create function public.create_event(name text, mode public.event_mode, currency text, display_name text)
returns table(event_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(create_event.name);
  v_display text := btrim(create_event.display_name);
  v_token text;
  v_event uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if create_event.currency is distinct from 'MYR' then
    raise exception 'unsupported_currency' using errcode = '22023';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if v_display is null or char_length(v_display) not between 1 and 40 then
    raise exception 'invalid_display_name' using errcode = '22023';
  end if;

  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_');
  v_token := translate(v_token, '=', '');

  insert into public.events (name, mode, currency, owner_user_id, invite_token_hash)
  values (v_name, create_event.mode, 'MYR', v_uid,
          encode(extensions.digest(v_token, 'sha256'), 'hex'))
  returning id into v_event;

  insert into public.event_members (event_id, user_id, display_name, role)
  values (v_event, v_uid, v_display, 'owner');

  return query select v_event, v_token;
end $$;

revoke execute on function public.create_event(text, public.event_mode, text, text) from public, anon;
grant execute on function public.create_event(text, public.event_mode, text, text) to authenticated;
