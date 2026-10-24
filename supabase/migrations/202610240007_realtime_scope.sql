-- Task 7b: realtime scope and 7a review carry-overs.
--
-- Realtime publishes ONLY public.events. Supabase Realtime does not apply RLS to
-- DELETE payloads, so row-level tables (expenses, items, allocations, members) must
-- not be published; clients subscribe to their open event and refetch when its
-- revision changes. Therefore EVERY mutation path must bump events.revision:
-- save_expense, claim/unclaim/assign, set_claiming_closed, set_member_role (all
-- already do), join_event (below) and a direct expense delete (trigger below).

-- Publication: events only (idempotent) ------------------------------------------------
do $$
declare
  t text;
begin
  if not exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['expenses', 'expense_items', 'allocations', 'event_members'] loop
    if exists(select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
  if not exists(select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;

-- join_event: same behaviour as 0004, plus a revision bump so open clients refresh
-- their member list (a re-join with a new display name also changes it).
create or replace function public.join_event(invite_token text, display_name text)
returns table(event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(join_event.display_name);
  v_event uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 40 then
    raise exception 'invalid_display_name' using errcode = '22023';
  end if;

  select e.id into v_event
  from public.events e
  where e.invite_token_hash = encode(extensions.digest(coalesce(join_event.invite_token, ''), 'sha256'), 'hex')
    and e.state = 'open';
  if v_event is null then
    raise exception 'invalid_invite' using errcode = 'P0002';
  end if;

  insert into public.event_members as m (event_id, user_id, display_name, role)
  values (v_event, v_uid, v_name, 'participant')
  on conflict (event_id, user_id) do update set display_name = excluded.display_name;

  update public.events e set revision = e.revision + 1 where e.id = v_event;

  return query select v_event;
end $$;

revoke execute on function public.join_event(text, text) from public, anon;
grant execute on function public.join_event(text, text) to authenticated;

-- Direct expense delete bumps the parent event's revision ---------------------------------
-- Only while the parent still exists: an event delete cascades to its expenses and
-- must keep working (no event row to update, no activity row to attach).
create function public.expense_deleted_bump()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists(select 1 from public.events e where e.id = old.event_id) then
    update public.events e set revision = e.revision + 1 where e.id = old.event_id;
    -- Redacted: ids only. The actor falls back to the creator outside a client session.
    insert into public.activity_log (event_id, actor_user_id, action, metadata)
    values (old.event_id, coalesce(auth.uid(), old.creator_user_id), 'expense_deleted',
      jsonb_build_object('expense_id', old.id));
  end if;
  return old;
end $$;

revoke execute on function public.expense_deleted_bump() from public, anon, authenticated;

create trigger expenses_bump_revision_on_delete after delete on public.expenses
  for each row execute function public.expense_deleted_bump();

-- 7a review carry-overs ---------------------------------------------------------------------
-- Equal re-split: byte-order tie-break, independent of the database collation.
create or replace function public.resplit_item_claims(p_item uuid)
returns void
language sql
set search_path = ''
as $$
  with c as (
    select a.id,
      row_number() over (order by a.participant_user_id::text collate "C") as rn,
      count(*) over () as n
    from public.allocations a
    where a.item_id = p_item
  )
  update public.allocations a
  set amount_cents = i.total_cents / c.n + case when c.rn <= i.total_cents % c.n then 1 else 0 end
  from c, public.expense_items i
  where a.id = c.id and i.id = p_item;
$$;

-- Membership is re-checked AFTER the event lock, so a member removed while waiting
-- for the lock is turned away.
create or replace function public.lock_item_expense(p_item uuid, p_uid uuid)
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
  if v_event is null then
    raise exception 'item_not_found' using errcode = '22023';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  if not exists(select 1 from public.event_members m where m.event_id = v_event and m.user_id = p_uid) then
    raise exception 'item_not_found' using errcode = '22023';
  end if;
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

-- The caller's role is read AFTER the event lock.
create or replace function public.set_claiming_closed(expense_id uuid, closed boolean)
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
  if v_event is null then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
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

revoke execute on function public.set_claiming_closed(uuid, boolean) from public, anon;
grant execute on function public.set_claiming_closed(uuid, boolean) to authenticated;
