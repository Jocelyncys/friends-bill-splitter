-- Batch 4 fix round: units sent as a whole JSON number with a fraction part ("units": 2.0) are accepted.
--
-- 0012 read units straight into integer recordset columns, so 2.0 failed with an untranslated 22P02
-- (invalid input syntax for type integer) instead of being taken as 2. Units are now read as numeric,
-- validated as before (whole, 1..2147483647, else invalid_units) and cast to integer explicitly afterwards.
-- unit_shares, assign_item_units and save_expense are otherwise identical to 0012.

-- unit_shares: units read as numeric.
create or replace function public.unit_shares(p_total bigint, p_quantity integer, p_rows jsonb)
returns table(participant_user_id uuid, amount_cents bigint)
language sql
immutable
set search_path = ''
as $$
  with r as (
    select t.participant_user_id as uid, t.units::numeric as units
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as t(participant_user_id uuid, units numeric)
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

-- assign_item_units: units read as numeric, cast after validation.
create or replace function public.assign_item_units(item_id uuid, member_units jsonb)
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
    case v_role when 'owner' then 'owner' when 'cohost' then 'cohost' else 'expense_creator' end, t.units::integer
  from jsonb_to_recordset(assign_item_units.member_units) as t(member_id uuid, units numeric);
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

-- save_expense: allocation units read as numeric, cast after validation.
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
  select v_id, a.item_id, a.participant_user_id, a.amount_cents, v_source, a.units::integer
  from jsonb_to_recordset(v_allocs) as a(item_id uuid, participant_user_id uuid, amount_cents numeric, units numeric);

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
