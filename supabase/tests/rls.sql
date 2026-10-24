begin;
select plan(26);

select has_table('public', 'events', 'events table exists');
select has_table('public', 'event_members', 'event_members table exists');
select policies_are('public', 'events', array['members_read_event', 'owner_updates_event'], 'events policies are exact');

select policies_are('public', 'event_members', array['members_read_members', 'managers_update_members'], 'event_members policies are exact');
select policies_are('public', 'expenses', array['members_read_expenses', 'members_create_own_expense', 'creators_or_managers_update_expense', 'creators_or_managers_delete_expense'], 'expenses policies are exact');
select policies_are('public', 'expense_items', array['members_read_expense_items', 'expense_writer_manages_items'], 'expense_items policies are exact');
select policies_are('public', 'allocations', array['members_read_allocations'], 'allocations policies are exact');
select policies_are('public', 'settlements', array['members_read_settlements'], 'settlements policies are exact');
select policies_are('public', 'settlement_balances', array['members_read_balances'], 'settlement_balances policies are exact');
select policies_are('public', 'settlement_transfers', array['transfer_parties_read_transfers'], 'settlement_transfers policies are exact');
select policies_are('public', 'payment_details', array['authorized_read_payment_details', 'receiver_inserts_own_payment_details', 'receiver_updates_own_payment_details'], 'payment_details policies are exact');
select policies_are('public', 'activity_log', array['members_read_activity'], 'activity_log policies are exact');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
  10, 'RLS is enabled on all 10 public tables');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  10, 'there are exactly 10 public tables');

select row_eq(
  $$select public from storage.buckets where id = 'payment-qr'$$,
  row(false),
  'payment-qr bucket exists and is private');
select ok(
  (select count(*) = 4 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'payment\_qr\_%'),
  'four payment-qr storage policies exist');
select ok(
  not exists(select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'payment\_qr\_%' and 'anon' = any(roles)),
  'payment-qr storage policies never target anon');

select is(public.payment_qr_path_uuid('not-a-uuid/also-bad/x', 1), null, 'malformed path segment returns null instead of erroring');
select is(public.payment_qr_path_uuid('11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/f', 2),
  '22222222-2222-2222-2222-222222222222'::uuid, 'well-formed path segment parses');

select is(
  (select has_function_privilege('anon', 'public.is_event_member(uuid)', 'execute')),
  false, 'anon cannot execute is_event_member');
select is(
  (select has_function_privilege('anon', 'public.owes_receiver(uuid, uuid)', 'execute')),
  false, 'anon cannot execute owes_receiver');
select is(
  (select has_function_privilege('authenticated', 'public.owes_receiver(uuid, uuid)', 'execute')),
  true, 'authenticated can execute owes_receiver');

-- No write policies on read-only tables (RLS default-deny for direct client writes).
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
    and tablename in ('allocations','settlements','settlement_balances','settlement_transfers','activity_log')
    and cmd <> 'SELECT'),
  0, 'server-managed tables have no client write policies');

-- Seed one event, then check non-members see nothing.
insert into auth.users (id, instance_id, aud, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Seed', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash');

set local role anon;
select throws_ok($$select count(*) from public.events$$, '42501', null, 'anon has no table privileges on events');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}', true);
select is((select count(*)::int from public.events), 0, 'authenticated non-member sees no events');
select is((select count(*)::int from public.payment_details), 0, 'authenticated non-member sees no payment details');
reset role;

select * from finish();
rollback;
