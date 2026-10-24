-- Helper functions -----------------------------------------------------------
create function public.is_event_member(target_event uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.event_members m where m.event_id = target_event and m.user_id = auth.uid());
$$;

create function public.has_event_role(target_event uuid, allowed public.event_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.event_members m where m.event_id = target_event and m.user_id = auth.uid() and m.role = any(allowed));
$$;

-- True when the caller is a payer who owes target_receiver in the event's settlement.
create function public.owes_receiver(target_event uuid, target_receiver uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(
    select 1
    from public.settlements s
    join public.settlement_transfers t on t.settlement_id = s.id
    where s.event_id = target_event
      and t.payer_user_id = auth.uid()
      and t.receiver_user_id = target_receiver
  );
$$;

revoke execute on function public.is_event_member(uuid) from public, anon;
revoke execute on function public.has_event_role(uuid, public.event_role[]) from public, anon;
revoke execute on function public.owes_receiver(uuid, uuid) from public, anon;
grant execute on function public.is_event_member(uuid) to authenticated;
grant execute on function public.has_event_role(uuid, public.event_role[]) to authenticated;
grant execute on function public.owes_receiver(uuid, uuid) to authenticated;

-- Enable RLS -----------------------------------------------------------------
alter table public.events enable row level security;
alter table public.event_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_items enable row level security;
alter table public.allocations enable row level security;
alter table public.settlements enable row level security;
alter table public.settlement_balances enable row level security;
alter table public.settlement_transfers enable row level security;
alter table public.payment_details enable row level security;
alter table public.activity_log enable row level security;

-- events / members -----------------------------------------------------------
create policy members_read_event on public.events for select using (public.is_event_member(id));
create policy owner_updates_event on public.events for update using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy members_read_members on public.event_members for select using (public.is_event_member(event_id));
create policy managers_update_members on public.event_members for update
  using (public.has_event_role(event_id, array['owner','cohost']::public.event_role[]))
  with check (public.has_event_role(event_id, array['owner','cohost']::public.event_role[]));

-- expenses -------------------------------------------------------------------
create policy members_read_expenses on public.expenses for select using (public.is_event_member(event_id));
create policy members_create_own_expense on public.expenses for insert with check (creator_user_id = auth.uid() and payer_user_id = auth.uid() and public.is_event_member(event_id));
create policy creators_or_managers_update_expense on public.expenses for update
  using (public.is_event_member(event_id)
    and (creator_user_id = auth.uid() or public.has_event_role(event_id, array['owner','cohost']::public.event_role[])))
  with check (public.is_event_member(event_id)
    and (creator_user_id = auth.uid() or public.has_event_role(event_id, array['owner','cohost']::public.event_role[]))
    and exists(select 1 from public.event_members m where m.event_id = expenses.event_id and m.user_id = expenses.payer_user_id));
create policy creators_or_managers_delete_expense on public.expenses for delete
  using (public.is_event_member(event_id)
    and (creator_user_id = auth.uid() or public.has_event_role(event_id, array['owner','cohost']::public.event_role[])));

create policy members_read_expense_items on public.expense_items for select using (
  exists(select 1 from public.expenses e where e.id = expense_items.expense_id and public.is_event_member(e.event_id))
);
create policy expense_writer_inserts_items on public.expense_items for insert
  with check (exists(select 1 from public.expenses e where e.id = expense_items.expense_id
    and (e.creator_user_id = auth.uid() or public.has_event_role(e.event_id, array['owner','cohost']::public.event_role[]))));
create policy expense_writer_updates_items on public.expense_items for update
  using (exists(select 1 from public.expenses e where e.id = expense_items.expense_id
    and (e.creator_user_id = auth.uid() or public.has_event_role(e.event_id, array['owner','cohost']::public.event_role[]))))
  with check (exists(select 1 from public.expenses e where e.id = expense_items.expense_id
    and (e.creator_user_id = auth.uid() or public.has_event_role(e.event_id, array['owner','cohost']::public.event_role[]))));
create policy expense_writer_deletes_items on public.expense_items for delete
  using (exists(select 1 from public.expenses e where e.id = expense_items.expense_id
    and (e.creator_user_id = auth.uid() or public.has_event_role(e.event_id, array['owner','cohost']::public.event_role[]))));

-- allocations (writes only via Task 7 functions) -------------------------------
create policy members_read_allocations on public.allocations for select using (
  exists(select 1 from public.expenses e where e.id = allocations.expense_id and public.is_event_member(e.event_id))
);

-- settlements (read-only for clients) ------------------------------------------
create policy members_read_settlements on public.settlements for select using (public.is_event_member(event_id));
create policy members_read_balances on public.settlement_balances for select using (
  exists(select 1 from public.settlements s where s.id = settlement_balances.settlement_id and public.is_event_member(s.event_id))
);
create policy transfer_parties_read_transfers on public.settlement_transfers for select using (
  payer_user_id = auth.uid()
  or receiver_user_id = auth.uid()
  or exists(select 1 from public.settlements s where s.id = settlement_transfers.settlement_id
    and public.has_event_role(s.event_id, array['owner','cohost']::public.event_role[]))
);

-- payment details --------------------------------------------------------------
create policy authorized_read_payment_details on public.payment_details for select using (
  receiver_user_id = auth.uid()
  or public.owes_receiver(event_id, receiver_user_id)
  or public.has_event_role(event_id, array['owner','cohost']::public.event_role[])
);
create policy receiver_inserts_own_payment_details on public.payment_details for insert
  with check (receiver_user_id = auth.uid() and public.is_event_member(event_id));
create policy receiver_updates_own_payment_details on public.payment_details for update
  using (receiver_user_id = auth.uid()) with check (receiver_user_id = auth.uid() and public.is_event_member(event_id));

-- activity (insert-only from security-definer functions) -----------------------
create policy members_read_activity on public.activity_log for select using (public.is_event_member(event_id));

-- Table privileges ---------------------------------------------------------------
-- Every user (including guests) is an authenticated anonymous-auth user; the anon
-- role never needs direct table access.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
-- truncate bypasses RLS, so clients never get it (nor references/trigger).
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- Column-level UPDATE: identity, ownership, state and revision columns are only
-- changed by security-definer functions (Tasks 4-9).
revoke update on public.events, public.event_members, public.expenses,
  public.expense_items, public.payment_details from authenticated;
grant update (name) on public.events to authenticated;
grant update (display_name) on public.event_members to authenticated;
grant update (payer_user_id, description, category, expense_date, total_cents, split_method, claiming_closed)
  on public.expenses to authenticated;
grant update (description, quantity, total_cents, sort_order) on public.expense_items to authenticated;
grant update (preferred_method, qr_storage_path, bank_name, account_holder_name, account_number, payment_reference, delete_after)
  on public.payment_details to authenticated;
