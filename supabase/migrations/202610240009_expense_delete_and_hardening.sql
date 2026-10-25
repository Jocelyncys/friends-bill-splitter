-- Final review fixes: expense delete through an RPC, and payment-qr bucket limits.
--
-- delete_expense(expense_id) raises SQLSTATE 22023 with a machine key as the message
-- (not_allowed, event_not_open); 28000 not_authenticated. A missing expense and a
-- caller who is not a member look the same (not_allowed).

-- Expense delete is RPC-only. The creators_or_managers_delete_expense policy keeps its
-- name (user decision: revoke privileges rather than drop policies) but is inert
-- without the privilege.
revoke delete on public.expenses from authenticated;

-- Lock order matches the other RPCs: find the event, lock it, then read the caller's
-- role (so a concurrent demotion is seen), then lock the expense.
-- The revision bump and the redacted 'expense_deleted' activity row come from the
-- existing expenses_bump_revision_on_delete trigger (0007), so they happen once.
create function public.delete_expense(expense_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event uuid;
  v_state public.event_state;
  v_role public.event_role;
  v_expense public.expenses;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select x.event_id into v_event from public.expenses x where x.id = delete_expense.expense_id;
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
  select * into v_expense from public.expenses x where x.id = delete_expense.expense_id for update;
  if not found or (v_role not in ('owner', 'cohost') and v_expense.creator_user_id <> v_uid) then
    raise exception 'not_allowed' using errcode = '22023';
  end if;

  delete from public.expenses x where x.id = v_expense.id;
end $$;

revoke execute on function public.delete_expense(uuid) from public, anon;
grant execute on function public.delete_expense(uuid) to authenticated;

-- payment-qr: server-side size and type limits (the client checks are bypassable).
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'payment-qr';
