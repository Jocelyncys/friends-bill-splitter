-- Batch 4: claim receipt items by unit.
--
-- An item with quantity > 1 ("2 x Teh Ais 7.00") is claimed by UNITS: each person says
-- how many they had (1..remaining). allocations.units holds that count. Rules:
-- * quantity = 1 items: unchanged. units is null; several people split the item equally
--   (allocateEqual: extra cents to ascending participant id, collate "C").
-- * quantity > 1 items: every allocation row written from now on carries units, and
--   sum(units) <= quantity (units_exceed_quantity). Amounts come from unit_shares():
--     - all units claimed: the item total split in proportion to units, cent-exact
--       (allocateProportionally: floor, then largest exact remainder, ties by id collate "C"),
--       e.g. 1000 over 2/1 units -> 667/333;
--     - some units unclaimed: each person gets floor(total * units / quantity) and the
--       rest stays unallocated, so the expense stays unresolved (confirm_settlement also
--       checks claimed units = quantity explicitly).
--   Rows with a null unit count on a quantity > 1 item can only come from before this
--   migration (the app always sent quantity 1); they keep the old equal split. A unit
--   write on such an item first counts each of them as 1 unit.
-- * Writers: claim_item_units(item, units) sets the caller's units (0 removes the claim);
--   claim_item = keep my claim or claim 1 unit; unclaim_item = remove my claim.
--   assign_item_units(item, [{member_id, units}]) replaces an item's allocations by units
--   (quantity 1: every units must be 1, then it is assign_item). assign_item(uuid, uuid[])
--   keeps working for quantity 1 items and for clearing ([]); a non-empty list on a
--   quantity > 1 item is invalid_units (it cannot say who had how many).
-- * save_expense: allocation rows take an optional "units" (JSON number); required on
--   quantity > 1 items and forbidden elsewhere (invalid_units); sum <= quantity
--   (units_exceed_quantity); amounts must equal unit_shares (invalid_allocation).
--   Self-claims kept across an edit keep their units. Lowering an item's quantity below
--   the units already self-claimed is rejected with quantity_below_claims (nothing is
--   cleared silently). Changing a quantity > 1 item to quantity 1 turns its claimers into
--   equal sharers (units null); 1 -> more counts each claimer as 1 unit.
--
-- New keys (SQLSTATE 22023): invalid_units, units_exceed_quantity, quantity_below_claims.

alter table public.allocations add column units integer null check (units > 0);

-- Single allocations of quantity > 1 items in open events had the whole item.
update public.allocations a
set units = i.quantity
from public.expense_items i
join public.expenses x on x.id = i.expense_id
join public.events e on e.id = x.event_id
where i.id = a.item_id and i.quantity > 1 and e.state = 'open'
  and (select count(*) from public.allocations b where b.item_id = a.item_id) = 1;

-- Unit math (internal) -------------------------------------------------------------------
-- p_rows: [{participant_user_id, units}] for one item of p_quantity units costing p_total.
create function public.unit_shares(p_total bigint, p_quantity integer, p_rows jsonb)
returns table(participant_user_id uuid, amount_cents bigint)
language sql
immutable
set search_path = ''
as $$
  with r as (
    select t.participant_user_id as uid, t.units::numeric as units
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as t(participant_user_id uuid, units integer)
  ), p as (
    select r.uid,
      div(p_total::numeric * r.units, p_quantity) as base,
      mod(p_total::numeric * r.units, p_quantity) as rem,
      (select coalesce(sum(x.units), 0) from r x) = p_quantity as complete
    from r
  ), o as (
    select p.uid, p.base, p.complete,
      row_number() over (order by p.rem desc, p.uid::text collate "C") as rn,
      p_total - sum(p.base) over () as leftover
    from p
  )
  select o.uid, (o.base + case when o.complete and o.rn <= o.leftover then 1 else 0 end)::bigint
  from o;
$$;

revoke execute on function public.unit_shares(bigint, integer, jsonb) from public, anon, authenticated;

-- Re-splits one item over its allocation rows: by units on a quantity > 1 item whose
-- rows all carry units, else equally (quantity 1 and legacy rows).
create or replace function public.resplit_item_claims(p_item uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_item public.expense_items;
begin
  select * into v_item from public.expense_items i where i.id = p_item;
  if not found then
    return;
  end if;
  if v_item.quantity > 1 and not exists(select 1 from public.allocations a where a.item_id = p_item and a.units is null) then
    update public.allocations a
    set amount_cents = s.amount_cents
    from public.unit_shares(v_item.total_cents, v_item.quantity,
      (select jsonb_agg(jsonb_build_object('participant_user_id', x.participant_user_id, 'units', x.units))
       from public.allocations x where x.item_id = p_item)) s
    where a.item_id = p_item and a.participant_user_id = s.participant_user_id;
  else
    with c as (
      select a.id,
        row_number() over (order by a.participant_user_id::text collate "C") as rn,
        count(*) over () as n
      from public.allocations a
      where a.item_id = p_item
    )
    update public.allocations a
    set amount_cents = v_item.total_cents / c.n + case when c.rn <= v_item.total_cents % c.n then 1 else 0 end
    from c
    where a.id = c.id;
  end if;
end $$;

revoke execute on function public.resplit_item_claims(uuid) from public, anon, authenticated;

-- Self-claims ----------------------------------------------------------------------------
-- Internal: sets the caller's claim on an item_claim item to p_units (0 removes it).
-- p_keep: leave an existing claim as it is (claim_item's "claim if I have not").
create function public.set_self_claim(p_item uuid, p_units integer, p_keep boolean)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_expense public.expenses;
  v_qty integer;
  v_mine integer;
  v_had boolean;
  v_others bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  -- Locks the event (then the expense) and re-checks membership after the lock.
  v_expense := public.lock_item_expense(p_item, v_uid);
  if v_expense.split_method <> 'item_claim' then
    raise exception 'not_claimable' using errcode = '22023';
  end if;
  if v_expense.claiming_closed then
    raise exception 'claiming_closed' using errcode = '22023';
  end if;
  if exists(select 1 from public.allocations a where a.item_id = p_item and a.source <> 'self_claim') then
    raise exception 'not_claimable' using errcode = '22023';
  end if;
  select i.quantity into v_qty from public.expense_items i where i.id = p_item;
  if p_units is null or p_units < 0 or (v_qty = 1 and p_units > 1) then
    raise exception 'invalid_units' using errcode = '22023';
  end if;

  select a.units into v_mine from public.allocations a where a.item_id = p_item and a.participant_user_id = v_uid;
  v_had := found;
  if p_keep and v_had then
    return; -- already claimed
  end if;

  if p_units = 0 then
    delete from public.allocations a where a.item_id = p_item and a.participant_user_id = v_uid;
    if not found then
      return; -- nothing to unclaim
    end if;
  elsif v_qty = 1 then
    if v_had then
      return;
    end if;
    insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
    values (v_expense.id, p_item, v_uid, 0, 'self_claim');
  else
    if v_had and v_mine = p_units then
      return; -- same count
    end if;
    -- Legacy rows without a count are one unit each.
    update public.allocations a set units = 1 where a.item_id = p_item and a.units is null;
    select coalesce(sum(a.units), 0) into v_others
    from public.allocations a where a.item_id = p_item and a.participant_user_id <> v_uid;
    if v_others + p_units > v_qty then
      raise exception 'units_exceed_quantity' using errcode = '22023';
    end if;
    if v_had then
      update public.allocations a set units = p_units where a.item_id = p_item and a.participant_user_id = v_uid;
    else
      insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source, units)
      values (v_expense.id, p_item, v_uid, 0, 'self_claim', p_units);
    end if;
  end if;
  perform public.resplit_item_claims(p_item);

  update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_expense.event_id, v_uid, case when p_units = 0 then 'item_unclaimed' else 'item_claimed' end,
    jsonb_build_object('expense_id', v_expense.id, 'item_id', p_item));
end $$;

revoke execute on function public.set_self_claim(uuid, integer, boolean) from public, anon, authenticated;

-- Claim the item (quantity > 1: one unit) unless I already have; repeat = no-op.
create or replace function public.claim_item(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.set_self_claim(claim_item.item_id, 1, true);
end $$;

create or replace function public.unclaim_item(item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.set_self_claim(unclaim_item.item_id, 0, false);
end $$;

-- How many units of the item I had (0 = none). Quantity 1 items take 0 or 1.
create function public.claim_item_units(item_id uuid, units integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.set_self_claim(claim_item_units.item_id, claim_item_units.units, false);
end $$;

revoke execute on function public.claim_item(uuid) from public, anon;
revoke execute on function public.unclaim_item(uuid) from public, anon;
revoke execute on function public.claim_item_units(uuid, integer) from public, anon;
grant execute on function public.claim_item(uuid) to authenticated;
grant execute on function public.unclaim_item(uuid) to authenticated;
grant execute on function public.claim_item_units(uuid, integer) to authenticated;

-- assign_item (uuid[]): unchanged except a non-empty list on a quantity > 1 item ----------
create or replace function public.assign_item(item_id uuid, member_ids uuid[])
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
  if assign_item.member_ids is null
    or array_position(assign_item.member_ids, null) is not null
    or (select count(distinct u) from unnest(assign_item.member_ids) as u) <> coalesce(cardinality(assign_item.member_ids), 0) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  if cardinality(assign_item.member_ids) = 0 then
    delete from public.allocations a where a.item_id = assign_item.item_id;
    if not found then
      return;
    end if;
    update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
    insert into public.activity_log (event_id, actor_user_id, action, metadata)
    values (v_expense.event_id, v_uid, 'item_unassigned',
      jsonb_build_object('expense_id', v_expense.id, 'item_id', assign_item.item_id));
    return;
  end if;

  -- A quantity > 1 item is assigned by units (assign_item_units).
  if exists(select 1 from public.expense_items i where i.id = assign_item.item_id and i.quantity > 1) then
    raise exception 'invalid_units' using errcode = '22023';
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

-- assign_item_units ------------------------------------------------------------------------
-- The expense creator (own expense) or an owner/co-host says who had how many units:
-- member_units = [{ member_id, units }] (distinct members, units >= 1, sum <= quantity).
-- Replaces the item's allocations. [] clears the item (as assign_item). On a quantity 1
-- item every units must be 1 and the item is split equally (assign_item).
create function public.assign_item_units(item_id uuid, member_units jsonb)
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
  v_qty integer;
  v_count bigint;
  v_distinct bigint;
  v_sum numeric;
  v_ok boolean;
  v_members jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_expense := public.lock_item_expense(assign_item_units.item_id, v_uid);
  select m.role into v_role from public.event_members m where m.event_id = v_expense.event_id and m.user_id = v_uid;
  if v_role not in ('owner', 'cohost') and v_expense.creator_user_id <> v_uid then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if jsonb_typeof(assign_item_units.member_units) is distinct from 'array' or exists(
      select 1 from jsonb_array_elements(assign_item_units.member_units) as e(v)
      where jsonb_typeof(e.v) is distinct from 'object'
        or jsonb_typeof(e.v->'member_id') is distinct from 'string') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_array_elements(assign_item_units.member_units) as e(v)
      where jsonb_typeof(e.v->'units') is distinct from 'number') then
    raise exception 'invalid_units' using errcode = '22023';
  end if;
  begin
    select count(*), count(distinct t.member_id), coalesce(sum(t.units), 0),
      coalesce(bool_and(t.units = trunc(t.units) and t.units between 1 and 2147483647), true)
    into v_count, v_distinct, v_sum, v_ok
    from jsonb_to_recordset(assign_item_units.member_units) as t(member_id uuid, units numeric);
  exception when invalid_text_representation then
    raise exception 'invalid_payload' using errcode = '22023';
  end;
  if v_distinct <> v_count then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not v_ok then
    raise exception 'invalid_units' using errcode = '22023';
  end if;

  select i.quantity into v_qty from public.expense_items i where i.id = assign_item_units.item_id;
  if v_count = 0 or v_qty = 1 then
    if v_qty = 1 and v_sum <> v_count then
      raise exception 'invalid_units' using errcode = '22023';
    end if;
    perform public.assign_item(assign_item_units.item_id,
      array(select t.member_id from jsonb_to_recordset(assign_item_units.member_units) as t(member_id uuid)));
    return;
  end if;
  if v_sum > v_qty then
    raise exception 'units_exceed_quantity' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(assign_item_units.member_units) as t(member_id uuid)
      where not exists(select 1 from public.event_members m where m.event_id = v_expense.event_id and m.user_id = t.member_id)) then
    raise exception 'not_member' using errcode = '22023';
  end if;

  delete from public.allocations a where a.item_id = assign_item_units.item_id;
  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source, units)
  select v_expense.id, assign_item_units.item_id, t.member_id, 0,
    case v_role when 'owner' then 'owner' when 'cohost' then 'cohost' else 'expense_creator' end, t.units
  from jsonb_to_recordset(assign_item_units.member_units) as t(member_id uuid, units integer);
  perform public.resplit_item_claims(assign_item_units.item_id);

  select jsonb_agg(t.member_id order by t.member_id::text collate "C") into v_members
  from jsonb_to_recordset(assign_item_units.member_units) as t(member_id uuid);

  update public.events e set revision = e.revision + 1 where e.id = v_expense.event_id;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_expense.event_id, v_uid, 'item_assigned',
    jsonb_build_object('expense_id', v_expense.id, 'item_id', assign_item_units.item_id, 'member_ids', v_members));
end $$;

revoke execute on function public.assign_item_units(uuid, jsonb) from public, anon;
grant execute on function public.assign_item_units(uuid, jsonb) to authenticated;

-- confirm_settlement: identical to 0010 plus: a quantity > 1 item whose rows carry units is
-- unresolved until every unit is claimed.
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
        or (x.total_cents > 0 and not exists(select 1 from public.allocations a where a.expense_id = x.id))
        -- Claimed by units: resolved only when every unit has someone.
        or exists(select 1 from public.expense_items i
          where i.expense_id = x.id and i.quantity > 1
            and exists(select 1 from public.allocations a where a.item_id = i.id and a.units is not null)
            and (select coalesce(sum(a.units), 0) from public.allocations a where a.item_id = i.id) <> i.quantity))) then
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

-- save_expense: identical to 0011 plus allocation units (see the header).
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

  -- Adjustments: id, known kind, 1-60 char label (or null for 'other'), non-zero signed integer cents (JSON
  -- numbers), unique ids (also across other expenses).
  if exists(
    select 1 from jsonb_array_elements(v_adjs) as e(v)
    where jsonb_typeof(e.v) is distinct from 'object'
      or jsonb_typeof(e.v->'id') is distinct from 'string'
      or jsonb_typeof(e.v->'kind') is distinct from 'string'
      or coalesce(jsonb_typeof(e.v->'label'), 'null') not in ('string', 'null')
      or jsonb_typeof(e.v->'amount_cents') is distinct from 'number'
      or coalesce(jsonb_typeof(e.v->'sort_order'), 'number') <> 'number') then
    raise exception 'invalid_adjustment' using errcode = '22023';
  end if;
  begin
    select count(*), count(distinct t.id), coalesce(sum(t.amount_cents), 0),
      bool_and(coalesce(
        t.id is not null
        and t.kind in ('discount', 'tax', 'service', 'rounding', 'other')
        and (char_length(btrim(t.label)) between 1 and 60 or (t.label is null and t.kind = 'other'))
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
  -- Optional units: a positive integer JSON number (or null / absent).
  if exists(
    select 1 from jsonb_array_elements(v_allocs) as e(v)
    where coalesce(jsonb_typeof(e.v->'units'), 'null') not in ('null', 'number')
      or (jsonb_typeof(e.v->'units') = 'number'
        and ((e.v->'units')::numeric <> trunc((e.v->'units')::numeric)
          or (e.v->'units')::numeric not between 1 and 2147483647))) then
    raise exception 'invalid_units' using errcode = '22023';
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
    if exists(select 1 from jsonb_to_recordset(v_allocs) as a(units numeric) where a.units is not null) then
      raise exception 'invalid_units' using errcode = '22023';
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
    -- Quantity 1 items take no units; every share of a quantity > 1 item says its units.
    if exists(
      select 1
      from jsonb_to_recordset(v_allocs) as a(item_id uuid, units numeric)
      join jsonb_to_recordset(v_items) as t(id uuid, quantity numeric) on t.id = a.item_id
      where (coalesce(t.quantity, 1) = 1) <> (a.units is null)) then
      raise exception 'invalid_units' using errcode = '22023';
    end if;
    if exists(
      select 1
      from jsonb_to_recordset(v_items) as t(id uuid, quantity numeric)
      join jsonb_to_recordset(v_allocs) as a(item_id uuid, units numeric) on a.item_id = t.id
      where coalesce(t.quantity, 1) > 1
      group by t.id, t.quantity
      having sum(a.units) > t.quantity) then
      raise exception 'units_exceed_quantity' using errcode = '22023';
    end if;
    -- A quantity 1 item is split equally among its assignees (allocateEqual / assign_item:
    -- extra cents to ascending participant id, byte order).
    if exists(
      select 1
      from (
        select a.amount_cents, t.total_cents,
          row_number() over (partition by a.item_id order by a.participant_user_id::text collate "C") as rn,
          count(*) over (partition by a.item_id) as n
        from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric)
        join jsonb_to_recordset(v_items) as t(id uuid, quantity numeric, total_cents numeric) on t.id = a.item_id
        where coalesce(t.quantity, 1) = 1
      ) s
      where s.amount_cents <> div(s.total_cents, s.n) + case when s.rn <= mod(s.total_cents, s.n) then 1 else 0 end) then
      raise exception 'invalid_allocation' using errcode = '22023';
    end if;
    -- A quantity > 1 item is split by units (unit_shares / allocateByUnits).
    if exists(
      select 1
      from jsonb_to_recordset(v_items) as t(id uuid, quantity numeric, total_cents numeric)
      cross join lateral public.unit_shares(t.total_cents::bigint, t.quantity::integer,
        (select jsonb_agg(jsonb_build_object('participant_user_id', a.participant_user_id, 'units', a.units))
         from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, units numeric)
         where a.item_id = t.id)) s
      join jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric)
        on a.item_id = t.id and a.participant_user_id = s.participant_user_id
      where coalesce(t.quantity, 1) > 1 and a.amount_cents <> s.amount_cents) then
      raise exception 'invalid_allocation' using errcode = '22023';
    end if;
  end if;

  -- Self-claims (Task 7) survive a re-save for items that keep their id.
  if v_is_update and v_existing.split_method = 'item_claim' and v_method = 'item_claim' then
    -- Kept claims keep their units on a quantity > 1 item (a claim without a count is one
    -- unit) and become equal sharers when the item's quantity is now 1.
    select coalesce(jsonb_agg(jsonb_build_object('item_id', a.item_id, 'participant_user_id', a.participant_user_id,
        'units', case when coalesce(t.quantity, 1) > 1 then coalesce(a.units, 1) end)), '[]'::jsonb)
    into v_claims
    from public.allocations a
    join jsonb_to_recordset(v_items) as t(id uuid, quantity numeric) on t.id = a.item_id
    where a.expense_id = v_id and a.source = 'self_claim';
    if exists(
      select 1 from jsonb_to_recordset(v_claims) as c(item_id uuid)
      join jsonb_to_recordset(v_allocs) as a(item_id uuid) on a.item_id = c.item_id) then
      raise exception 'item_has_claims' using errcode = '22023';
    end if;
    -- Never drop claims silently: a quantity lowered below the units already claimed is rejected.
    if exists(
      select 1
      from jsonb_to_recordset(v_claims) as c(item_id uuid, units integer)
      join jsonb_to_recordset(v_items) as t(id uuid, quantity numeric) on t.id = c.item_id
      where c.units is not null
      group by t.id, t.quantity
      having sum(c.units) > t.quantity) then
      raise exception 'quantity_below_claims' using errcode = '22023';
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
  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source, units)
  select v_id, a.item_id, a.participant_user_id, a.amount_cents, v_source, a.units
  from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric, units integer);

  insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source, units)
  select v_id, c.item_id, c.participant_user_id, 0, 'self_claim', c.units
  from jsonb_to_recordset(v_claims) as c(item_id uuid, participant_user_id uuid, units integer);
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
