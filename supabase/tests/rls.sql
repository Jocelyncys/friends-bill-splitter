begin;
select plan(49);

select has_table('public', 'events', 'events table exists');
select has_table('public', 'event_members', 'event_members table exists');
select policies_are('public', 'events', array['members_read_event', 'owner_updates_event'], 'events policies are exact');

select policies_are('public', 'event_members', array['members_read_members', 'managers_update_members'], 'event_members policies are exact');
select policies_are('public', 'expenses', array['members_read_expenses', 'members_create_own_expense', 'creators_or_managers_update_expense', 'creators_or_managers_delete_expense'], 'expenses policies are exact');
select policies_are('public', 'expense_items', array['members_read_expense_items', 'expense_writer_inserts_items', 'expense_writer_updates_items', 'expense_writer_deletes_items'], 'expense_items policies are exact');
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
  (select has_function_privilege('anon', 'public.has_event_role(uuid, public.event_role[])', 'execute')),
  false, 'anon cannot execute has_event_role');
select is(
  (select has_function_privilege('authenticated', 'public.owes_receiver(uuid, uuid)', 'execute')),
  true, 'authenticated can execute owes_receiver');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
  0, 'anon has no direct privileges on any public table');

-- No write policies on read-only tables (RLS default-deny for direct client writes).
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
    and tablename in ('allocations','settlements','settlement_balances','settlement_transfers','activity_log')
    and cmd <> 'SELECT'),
  0, 'server-managed tables have no client write policies');

-- Seed: A owner, B cohost, C participant (expense creator, owes A), D outsider.
insert into auth.users (id, instance_id, aud, role)
select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'
from unnest(array[
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd']::uuid[]) as u;
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Seed', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B', 'cohost'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('f0000000-0000-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Dinner', current_date, 1000, 'equal');
insert into public.settlements (id, event_id, method, confirmed_by)
values ('f2000000-0000-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'original_payers', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.settlement_transfers (settlement_id, payer_user_id, receiver_user_id, amount_cents)
values ('f2000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500);
insert into public.payment_details (event_id, receiver_user_id, preferred_method, account_number) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bank', '111'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bank', '222');

create function pg_temp.upd_count(q text) returns int language plpgsql as $$
declare n int;
begin
  execute q;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function pg_temp.upd_count(text) to public;

select throws_ok(
  $$insert into public.payment_details (event_id, receiver_user_id, preferred_method, qr_storage_path)
    values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'qr', 'other/path/x')$$,
  '23514', null, 'qr_storage_path must live under the receiver own folder');

-- D: outsider
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select is((select count(*)::int from public.events), 0, 'non-member sees no events');
select is((select count(*)::int from public.payment_details), 0, 'non-member sees no payment details');
select throws_ok(
  $$insert into public.expense_items (id, expense_id, description, total_cents)
    values ('f1000000-0000-0000-0000-000000000009', 'f0000000-0000-0000-0000-000000000001', 'x', 1)$$,
  '42501', null, 'non-member cannot add items to an expense');
reset role;

-- C: participant, expense creator, owes A
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select is((select count(*)::int from public.events), 1, 'member sees their event');
select is((select count(*)::int from public.payment_details where receiver_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'payer sees the receiver they owe');
select is((select count(*)::int from public.payment_details where receiver_user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'payer does not see a receiver they do not owe');
select throws_ok($$update public.event_members set role = 'owner' where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  '42501', null, 'participant cannot change a role');
select throws_ok($$update public.expenses set event_id = 'eeeeeeee-eeee-eeee-eeee-000000000000' where id = 'f0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'creator cannot move an expense to another event');
select throws_ok($$update public.expenses set payer_user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' where id = 'f0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'creator cannot set a non-member as payer');
select is(pg_temp.upd_count($q$update public.expenses set description = 'Lunch' where id = 'f0000000-0000-0000-0000-000000000001'$q$),
  1, 'creator can edit their expense description');
select lives_ok($$insert into public.expense_items (id, expense_id, description, total_cents)
  values ('f1000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'x', 1)$$,
  'creator can add items');
select throws_ok($$update public.expense_items set expense_id = 'f0000000-0000-0000-0000-000000000002' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'items cannot be repointed to another expense');
select lives_ok($$insert into storage.objects (bucket_id, name) values
  ('payment-qr', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/cccccccc-cccc-cccc-cccc-cccccccccccc/11111111-1111-1111-1111-111111111111')$$,
  'receiver can upload into their own folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('payment-qr', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/cccccccc-cccc-cccc-cccc-cccccccccccc/extra/11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'extra path depth is rejected');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('payment-qr', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/cccccccc-cccc-cccc-cccc-cccccccccccc/not-a-uuid')$$,
  '42501', null, 'non-uuid filename is rejected');
select throws_ok($$insert into storage.objects (bucket_id, name) values
  ('payment-qr', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'cannot upload into another receiver folder');
reset role;

-- B: cohost
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select throws_ok($$update public.event_members set role = 'owner' where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$,
  '42501', null, 'cohost cannot promote themselves');
select throws_ok($$update public.event_members set role = 'participant' where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  '42501', null, 'cohost cannot demote the owner');
select throws_ok($$update public.event_members set user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$$,
  '42501', null, 'cohost cannot reassign a member user_id');
select is(pg_temp.upd_count($q$update public.event_members set display_name = 'Cee' where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'$q$),
  1, 'manager can still edit a display name');
reset role;

-- A: owner
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$update public.events set state = 'settled' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$$,
  '42501', null, 'owner cannot set event state directly');
select throws_ok($$update public.events set revision = 99 where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$$,
  '42501', null, 'owner cannot set revision directly');
select is(pg_temp.upd_count($q$update public.events set name = 'Renamed' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'$q$),
  1, 'owner can rename the event');
reset role;

select * from finish();
rollback;
