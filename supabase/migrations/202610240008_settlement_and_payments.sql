-- Task 9a: settlement confirmation, payment tracking and receiver details.
--
-- confirm_settlement recomputes balances and transfers on the server with the same
-- algorithms as src/domain/settlement.ts (id ties broken by byte order, collate "C",
-- matching compareIds) and stores one immutable snapshot per event. Payment state
-- changes go only through mark_payment_sent / confirm_payment_received /
-- override_payment_state; each change writes a payment_events row. Clients never
-- write snapshot tables or payment_events.
--
-- Errors: SQLSTATE 22023 with a machine key (not_allowed, event_not_open,
-- already_settled, invalid_payload, coordinator_required, coordinator_not_creditor,
-- no_expenses, unresolved_expenses, transfer_not_found, event_not_settled,
-- invalid_transition, invalid_reason); 40001 stale_revision; 28000 not_authenticated.
-- payment_state 'confirmed' is the plan's "received".

-- payment_events -------------------------------------------------------------------
create table public.payment_events (
  id bigint generated always as identity primary key,
  transfer_id uuid not null references public.settlement_transfers(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  old_state public.payment_state not null,
  new_state public.payment_state not null,
  reason text check (reason is null or char_length(reason) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table public.payment_events enable row level security;
-- Visible exactly when the transfer is visible (the transfer read policy applies inside).
create policy transfer_parties_read_payment_events on public.payment_events for select using (
  exists(select 1 from public.settlement_transfers t where t.id = payment_events.transfer_id)
);

-- The snapshot and payment history are written only by the functions below.
revoke insert, update, delete, truncate, references, trigger on public.payment_events from authenticated;
revoke insert, update, delete on public.settlements, public.settlement_balances, public.settlement_transfers
  from authenticated;

-- delete_after is set by the server when the event is fully paid; receivers write the rest.
revoke insert on public.payment_details from authenticated;
grant insert (event_id, receiver_user_id, preferred_method, qr_storage_path, bank_name, account_holder_name,
  account_number, payment_reference) on public.payment_details to authenticated;
revoke update (delete_after) on public.payment_details from authenticated;

-- Internal helpers (not callable by clients) -----------------------------------------

-- Per member who paid or shares in any expense: paid = sum(expenses.total_cents) as
-- payer, owed = sum(allocations.amount_cents), net = paid - owed (calculateBalances).
create function public.compute_settlement_balances(p_event uuid)
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
    select a.participant_user_id as uid, sum(a.amount_cents) as cents
    from public.allocations a join public.expenses x on x.id = a.expense_id
    where x.event_id = p_event
    group by a.participant_user_id
  )
  select coalesce(p.uid, o.uid),
    coalesce(p.cents, 0)::bigint,
    coalesce(o.cents, 0)::bigint,
    (coalesce(p.cents, 0) - coalesce(o.cents, 0))::bigint
  from paid p full join owed o on o.uid = p.uid
  order by coalesce(p.uid, o.uid)::text collate "C";
$$;

-- Transfers in the exact order of the TS functions:
--   original_payers  = settleOriginalPayers (per participant -> payer pair, not netted)
--   optimized_direct = settleOptimizedDirect (greedy, amount desc then id)
--   coordinator      = settleViaCoordinator (debtors by id, then other creditors by id)
create function public.compute_settlement_transfers(p_event uuid, p_method public.settlement_method, p_coordinator uuid)
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
      select a.participant_user_id, x.payer_user_id, sum(a.amount_cents)::bigint
      from public.allocations a join public.expenses x on x.id = a.expense_id
      where x.event_id = p_event and a.participant_user_id <> x.payer_user_id and a.amount_cents > 0
      group by a.participant_user_id, x.payer_user_id
      order by a.participant_user_id::text collate "C", x.payer_user_id::text collate "C";
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

-- Once every transfer of the event's settlement is confirmed, the server-side copy of
-- payment details is due for deletion in seven days (the cleanup job is separate).
create function public.schedule_payment_details_cleanup(p_event uuid)
returns void
language sql
set search_path = ''
as $$
  update public.payment_details d
  set delete_after = now() + interval '7 days'
  where d.event_id = p_event
    and not exists(
      select 1 from public.settlements s join public.settlement_transfers t on t.settlement_id = s.id
      where s.event_id = p_event and t.state <> 'confirmed');
$$;

-- Applies one payment transition for the current user. p_kind: 'sent' (payer,
-- pending -> sent), 'received' (receiver, sent -> confirmed) or 'override'
-- (owner/co-host, pending|sent -> p_target, which must be 'confirmed', with a reason).
-- Locks the event row, then the transfer row. Repeating a transition that already
-- happened returns without writing.
create function public.apply_payment_transition(p_transfer uuid, p_kind text, p_target public.payment_state, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event uuid;
  v_event_state public.event_state;
  v_transfer public.settlement_transfers;
  v_role public.event_role;
  v_manager boolean;
  v_reason text;
  v_new public.payment_state;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select s.event_id into v_event
  from public.settlement_transfers t join public.settlements s on s.id = t.settlement_id
  where t.id = p_transfer;
  if v_event is null then
    raise exception 'transfer_not_found' using errcode = '22023';
  end if;
  select e.state into v_event_state from public.events e where e.id = v_event for update;
  select * into v_transfer from public.settlement_transfers t where t.id = p_transfer for update;
  -- Role read AFTER the event lock.
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  v_manager := coalesce(v_role in ('owner', 'cohost'), false);
  -- Members who are neither a party nor a manager cannot tell the transfer exists.
  if v_transfer.id is null or v_role is null
    or (not v_manager and v_uid <> v_transfer.payer_user_id and v_uid <> v_transfer.receiver_user_id) then
    raise exception 'transfer_not_found' using errcode = '22023';
  end if;
  if v_event_state is distinct from 'settled' then
    raise exception 'event_not_settled' using errcode = '22023';
  end if;

  if p_kind = 'sent' then
    if v_uid <> v_transfer.payer_user_id then
      raise exception 'not_allowed' using errcode = '22023';
    end if;
    if v_transfer.state = 'sent' then
      return;
    end if;
    if v_transfer.state <> 'pending' then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    v_new := 'sent';
  elsif p_kind = 'received' then
    if v_uid <> v_transfer.receiver_user_id then
      raise exception 'not_allowed' using errcode = '22023';
    end if;
    if v_transfer.state = 'confirmed' then
      return;
    end if;
    if v_transfer.state <> 'sent' then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    v_new := 'confirmed';
  elsif p_kind = 'override' then
    if not v_manager then
      raise exception 'not_allowed' using errcode = '22023';
    end if;
    if p_target is distinct from 'confirmed' then
      raise exception 'invalid_transition' using errcode = '22023';
    end if;
    v_reason := btrim(p_reason);
    if v_reason is null or char_length(v_reason) not between 1 and 500 then
      raise exception 'invalid_reason' using errcode = '22023';
    end if;
    if v_transfer.state = 'confirmed' then
      return;
    end if;
    v_new := 'confirmed';
  else
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  update public.settlement_transfers t set state = v_new, updated_at = now() where t.id = p_transfer;
  insert into public.payment_events (transfer_id, actor_user_id, old_state, new_state, reason)
  values (p_transfer, v_uid, v_transfer.state, v_new, v_reason);

  update public.events e set revision = e.revision + 1 where e.id = v_event;
  -- Redacted: transfer id and states only (no amounts, bank details, QR paths or reasons).
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid,
    case p_kind when 'sent' then 'payment_sent' when 'received' then 'payment_confirmed' else 'payment_overridden' end,
    jsonb_build_object('transfer_id', p_transfer, 'old_state', v_transfer.state, 'new_state', v_new));

  if v_new = 'confirmed' then
    perform public.schedule_payment_details_cleanup(v_event);
  end if;
end $$;

revoke execute on function public.compute_settlement_balances(uuid) from public, anon, authenticated;
revoke execute on function public.compute_settlement_transfers(uuid, public.settlement_method, uuid) from public, anon, authenticated;
revoke execute on function public.schedule_payment_details_cleanup(uuid) from public, anon, authenticated;
revoke execute on function public.apply_payment_transition(uuid, text, public.payment_state, text) from public, anon, authenticated;

-- confirm_settlement -----------------------------------------------------------------
create function public.confirm_settlement(event_id uuid, method public.settlement_method, coordinator_id uuid,
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
  -- Spec 18: settlement cannot begin while any expense has unallocated (or over-allocated) cents.
  if exists(
    select 1 from public.expenses x
    where x.event_id = v_event
      and x.total_cents <> coalesce((select sum(a.amount_cents) from public.allocations a where a.expense_id = x.id), 0)) then
    raise exception 'unresolved_expenses' using errcode = '22023';
  end if;

  insert into public.settlements (event_id, method, coordinator_user_id, confirmed_by)
  values (v_event, confirm_settlement.method, confirm_settlement.coordinator_id, v_uid)
  returning id into v_settlement;

  insert into public.settlement_balances (settlement_id, user_id, paid_cents, owed_cents, net_cents)
  select v_settlement, b.user_id, b.paid_cents, b.owed_cents, b.net_cents
  from public.compute_settlement_balances(v_event) b;

  -- Raises coordinator_not_creditor (rolling everything back) for a bad coordinator.
  insert into public.settlement_transfers (settlement_id, payer_user_id, receiver_user_id, amount_cents)
  select v_settlement, t.payer_user_id, t.receiver_user_id, t.amount_cents
  from public.compute_settlement_transfers(v_event, confirm_settlement.method, confirm_settlement.coordinator_id) t;

  -- From here the open-event trigger makes the event's expense data read-only.
  update public.events e set state = 'settled', settled_at = now(), revision = e.revision + 1 where e.id = v_event;

  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, 'settlement_confirmed',
    jsonb_build_object('settlement_id', v_settlement, 'method', confirm_settlement.method));

  -- A settlement with no transfers is already fully paid.
  perform public.schedule_payment_details_cleanup(v_event);

  return v_settlement;
end $$;

-- Payment transitions ---------------------------------------------------------------
create function public.mark_payment_sent(transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.apply_payment_transition(mark_payment_sent.transfer_id, 'sent', null, null);
end $$;

create function public.confirm_payment_received(transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.apply_payment_transition(confirm_payment_received.transfer_id, 'received', null, null);
end $$;

create function public.override_payment_state(transfer_id uuid, target_state public.payment_state, reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.apply_payment_transition(override_payment_state.transfer_id, 'override',
    override_payment_state.target_state, override_payment_state.reason);
end $$;

-- get_receiver_details ----------------------------------------------------------------
-- For the transfer's payer, its receiver, or an owner/co-host of a settled event.
-- Returns the stored QR object path only; the client mints a 10-minute signed URL
-- (storage RLS authorizes the same people) and never persists it. No row when the
-- receiver has not entered details.
create function public.get_receiver_details(transfer_id uuid)
returns table(receiver_user_id uuid, preferred_method text, bank_name text, account_holder_name text,
  account_number text, payment_reference text, qr_storage_path text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event uuid;
  v_payer uuid;
  v_receiver uuid;
  v_event_state public.event_state;
  v_role public.event_role;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select s.event_id, t.payer_user_id, t.receiver_user_id into v_event, v_payer, v_receiver
  from public.settlement_transfers t join public.settlements s on s.id = t.settlement_id
  where t.id = get_receiver_details.transfer_id;
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_event is null or v_role is null
    or (v_role not in ('owner', 'cohost') and v_uid <> v_payer and v_uid <> v_receiver) then
    raise exception 'transfer_not_found' using errcode = '22023';
  end if;
  select e.state into v_event_state from public.events e where e.id = v_event;
  if v_event_state is distinct from 'settled' then
    raise exception 'event_not_settled' using errcode = '22023';
  end if;

  return query
    select d.receiver_user_id, d.preferred_method, d.bank_name, d.account_holder_name, d.account_number,
      d.payment_reference, d.qr_storage_path
    from public.payment_details d
    where d.event_id = v_event and d.receiver_user_id = v_receiver;
end $$;

revoke execute on function public.confirm_settlement(uuid, public.settlement_method, uuid, bigint) from public, anon;
revoke execute on function public.mark_payment_sent(uuid) from public, anon;
revoke execute on function public.confirm_payment_received(uuid) from public, anon;
revoke execute on function public.override_payment_state(uuid, public.payment_state, text) from public, anon;
revoke execute on function public.get_receiver_details(uuid) from public, anon;
grant execute on function public.confirm_settlement(uuid, public.settlement_method, uuid, bigint) to authenticated;
grant execute on function public.mark_payment_sent(uuid) to authenticated;
grant execute on function public.confirm_payment_received(uuid) to authenticated;
grant execute on function public.override_payment_state(uuid, public.payment_state, text) to authenticated;
grant execute on function public.get_receiver_details(uuid) to authenticated;

-- save_expense: the caller's role is read AFTER the event lock (7b review carry-over).
-- Identical to the 0006 version otherwise.
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
