begin;
select plan(119);

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
-- Expense data is written only through save_expense (Task 5a); direct writes are denied.
select throws_ok($$update public.expenses set description = 'Lunch' where id = 'f0000000-0000-0000-0000-000000000001'$$,
  '42501', 'permission denied for table expenses', 'creator cannot edit expense columns directly');
select throws_ok($$update public.expenses set total_cents = 1 where id = 'f0000000-0000-0000-0000-000000000001'$$,
  '42501', 'permission denied for table expenses', 'creator cannot change the total directly');
select throws_ok($$insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
  values ('f0000000-0000-0000-0000-000000000003', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Direct', current_date, 100, 'equal')$$,
  '42501', 'permission denied for table expenses', 'participant cannot insert an expense directly');
select throws_ok($$insert into public.expense_items (id, expense_id, description, total_cents)
  values ('f1000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'x', 1)$$,
  '42501', 'permission denied for table expense_items', 'creator cannot insert items directly');
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

-- Task 4: create_event / join_event RPCs -----------------------------------
select is((select has_function_privilege('anon', 'public.create_event(text, public.event_mode, text, text)', 'execute')),
  false, 'anon cannot execute create_event');
select is((select has_function_privilege('anon', 'public.join_event(text, text)', 'execute')),
  false, 'anon cannot execute join_event');
select is((select has_function_privilege('authenticated', 'public.create_event(text, public.event_mode, text, text)', 'execute')),
  true, 'authenticated can execute create_event');
select is((select has_function_privilege('authenticated', 'public.join_event(text, text)', 'execute')),
  true, 'authenticated can execute join_event');

create temp table rpc_result (event_id uuid, invite_token text);
grant all on rpc_result to public;

set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
insert into rpc_result select * from public.create_event('RPC Trip', 'trip_event', 'MYR', '  Dee  ');
select is((select count(*)::int from rpc_result), 1, 'create_event returns one row');
select ok((select char_length(invite_token) = 43 and invite_token ~ '^[A-Za-z0-9_-]+$' from rpc_result), 'token is 43-char Base64URL');
select throws_ok($$select * from public.create_event('Bad', 'trip_event', 'USD', 'Dee')$$, null, null, 'non-MYR currency rejected');
select throws_ok($$select * from public.create_event('   ', 'trip_event', 'MYR', 'Dee')$$, null, null, 'blank event name rejected');
select throws_ok($$select * from public.create_event('Ok', 'trip_event', 'MYR', '   ')$$, '22023', 'invalid_display_name', 'blank owner display name rejected');
select throws_ok($$select * from public.create_event('Ok', 'trip_event', 'MYR', repeat('x', 41))$$, '22023', 'invalid_display_name', 'owner display name over 40 chars rejected');
reset role;

select is((select role::text from public.event_members m join rpc_result r on r.event_id = m.event_id
  where m.user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'owner', 'create_event makes the caller owner');
select is((select display_name from public.event_members m join rpc_result r on r.event_id = m.event_id
  where m.user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'Dee', 'create_event stores the trimmed owner display name');
select is((select count(*)::int from pg_proc where proname = 'create_event' and pronamespace = 'public'::regnamespace),
  1, 'the old 3-arg create_event signature is dropped');
select is((select e.invite_token_hash from public.events e join rpc_result r on r.event_id = e.id),
  (select encode(extensions.digest(invite_token, 'sha256'), 'hex') from rpc_result), 'stored hash is sha256 hex of the returned token');
select is((select count(*)::int from public.events e join rpc_result r on r.event_id = e.id where e.invite_token_hash = r.invite_token),
  0, 'plain token is not stored');

-- join_event
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select * from public.join_event('not-a-real-token', 'Cee')$$, 'P0002', 'invalid_invite', 'invalid token rejected');
select throws_ok($$select * from public.join_event((select invite_token from rpc_result), '   ')$$, null, null, 'whitespace display name rejected');
select throws_ok($$select * from public.join_event((select invite_token from rpc_result), '')$$, null, null, 'empty display name rejected');
select throws_ok($$select * from public.join_event((select invite_token from rpc_result), repeat('x', 41))$$, null, null, 'display name over 40 chars rejected');
select is((select event_id from public.join_event((select invite_token from rpc_result), '  Cee  ')),
  (select event_id from rpc_result), 'join_event returns the event id');
select lives_ok($$select * from public.join_event((select invite_token from rpc_result), 'Cee2')$$, 'duplicate join is idempotent');
reset role;
select is((select count(*)::int from public.event_members m join rpc_result r on r.event_id = m.event_id
  where m.user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 1, 'duplicate join leaves exactly one membership row');
select is((select display_name from public.event_members m join rpc_result r on r.event_id = m.event_id
  where m.user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'Cee2', 'duplicate join updates the display name');
select is((select role::text from public.event_members m join rpc_result r on r.event_id = m.event_id
  where m.user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'participant', 'joiner is a participant');

-- owner re-joining keeps owner role
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select lives_ok($$select * from public.join_event((select invite_token from rpc_result), 'Dee')$$, 'owner can re-join');
reset role;
select is((select role::text from public.event_members m join rpc_result r on r.event_id = m.event_id
  where m.user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'owner', 'owner re-join does not downgrade the role');

-- non-open event
update public.events set state = 'settled' where id = (select event_id from rpc_result);
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select throws_ok($$select * from public.join_event((select invite_token from rpc_result), 'Bee')$$, 'P0002', 'invalid_invite', 'join of a non-open event rejected');
reset role;

-- Task 5a: save_expense RPC, open-event trigger, payer column grant ----------
select is((select has_function_privilege('anon', 'public.save_expense(jsonb)', 'execute')),
  false, 'anon cannot execute save_expense');
select is((select has_function_privilege('authenticated', 'public.save_expense(jsonb)', 'execute')),
  true, 'authenticated can execute save_expense');
select is((select has_function_privilege('authenticated', 'public.enforce_open_event()', 'execute')),
  false, 'clients cannot execute the open-event trigger function');
select is((select has_column_privilege('authenticated', 'public.expenses', 'payer_user_id', 'update')),
  false, 'payer_user_id is not directly updatable by clients');
select ok(not has_any_column_privilege('authenticated', 'public.expenses', 'insert, update')
    and not has_any_column_privilege('authenticated', 'public.expense_items', 'insert, update')
    and not has_table_privilege('authenticated', 'public.expense_items', 'delete'),
  'clients have no insert/update on expenses and no writes on expense_items');

create function pg_temp.al(p_item uuid, p_who uuid, p_amt int) returns jsonb language sql as $$
  select jsonb_build_object('item_id', p_item, 'participant_user_id', p_who, 'amount_cents', p_amt) $$;
create function pg_temp.it(p_id uuid, p_total int, p_sort int) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'description', 'Item', 'quantity', 1, 'total_cents', p_total, 'sort_order', p_sort) $$;
create function pg_temp.exp(p_id uuid, p_payer uuid, p_total jsonb, p_method text, p_items jsonb, p_allocs jsonb,
  p_event uuid default 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'event_id', p_event, 'payer_user_id', p_payer, 'description', 'Nasi lemak',
    'category', 'food', 'expense_date', '2026-10-24', 'total_cents', p_total, 'split_method', p_method,
    'items', p_items, 'allocations', p_allocs) $$;
grant execute on function pg_temp.al(uuid, uuid, int), pg_temp.it(uuid, int, int),
  pg_temp.exp(uuid, uuid, jsonb, text, jsonb, jsonb, uuid) to public;

-- Second open event (A owner, C participant) for the event_id-change and trigger tests.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('5ae00000-0000-0000-0000-000000000002', 'Second', 'trip_event', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash2');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('5ae00000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('5ae00000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant');

-- C: participant
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select is(public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1200', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 600), pg_temp.al(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 600)))),
  '5a000000-0000-0000-0000-000000000001'::uuid, 'participant saves their own equal expense');
select is(public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1200', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 600), pg_temp.al(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 600)))),
  '5a000000-0000-0000-0000-000000000001'::uuid, 'retrying the same payload returns the same id');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1200', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1200))))$$,
  '22023', 'payer_not_allowed', 'participant cannot choose another payer');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1200', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 600), pg_temp.al(null, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 600))))$$,
  '22023', 'not_member', 'allocation to a non-member is rejected');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1200', 'custom', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 600), pg_temp.al(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500))))$$,
  '22023', 'allocation_mismatch', 'custom shares must sum to the total');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1000', 'item_claim',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000009', 500, 0), pg_temp.it('5a100000-0000-0000-0000-000000000009', 500, 1)), '[]'))$$,
  '22023', 'duplicate_item_id', 'duplicate item ids are rejected');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '0', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 0))))$$,
  '22023', 'invalid_total', 'zero total is rejected');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '12.5', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 12))))$$,
  '22023', 'invalid_total', 'non-integer total is rejected');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1000', 'item_claim',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000009', 400, 0)), '[]'))$$,
  '22023', 'item_total_mismatch', 'item totals must sum to the expense total');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '500', 'item_claim',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000009', 500, 0)),
    jsonb_build_array(pg_temp.al('5a100000-0000-0000-0000-000000000008', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 100))))$$,
  '22023', 'invalid_allocation', 'item allocation must reference an item of the payload');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '500', 'item_claim',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000009', 500, 0)),
    jsonb_build_array(pg_temp.al('5a100000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 600))))$$,
  '22023', 'allocation_exceeds_item', 'per-item allocations cannot exceed the item total');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '500', 'equal',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000009', 500, 0)),
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 500))))$$,
  '22023', 'items_not_allowed', 'equal split cannot carry items');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '500', 'custom', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', null))))$$,
  '22023', 'invalid_allocation', 'null allocation amount is rejected');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '500', 'item_claim',
    jsonb_build_array(jsonb_build_object('id', '5a100000-0000-0000-0000-000000000009', 'description', 'Item', 'quantity', 1, 'total_cents', '500', 'sort_order', 0)),
    '[]'))$$,
  '22023', 'invalid_item', 'string item amount is rejected');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1200', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1200)), '5ae00000-0000-0000-0000-000000000002'))$$,
  '22023', 'event_mismatch', 'an existing expense cannot move to another event');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '100', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 100)), (select event_id from rpc_result)))$$,
  '22023', 'event_not_open', 'saving into a settled event is rejected');
select throws_ok($$update public.expenses set payer_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' where id = '5a000000-0000-0000-0000-000000000001'$$,
  '42501', 'permission denied for table expenses', 'participant cannot change the payer by direct UPDATE');
reset role;

select is((select count(*)::int from public.expenses where id = '5a000000-0000-0000-0000-000000000001'), 1, 'retry leaves exactly one expense');
select row_eq($$select creator_user_id, payer_user_id, total_cents from public.expenses where id = '5a000000-0000-0000-0000-000000000001'$$,
  row('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 1200::bigint),
  'expense stored with the caller as creator and payer');
select is((select count(*)::int from public.allocations where expense_id = '5a000000-0000-0000-0000-000000000001'), 2, 'retry leaves the same allocation rows');
select is((select array_agg(distinct source) from public.allocations where expense_id = '5a000000-0000-0000-0000-000000000001'),
  array['calculated'], 'equal shares are server-sourced as calculated');
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), 2::bigint, 'each successful save bumps the event revision');
select is((select metadata from public.activity_log where event_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and action = 'expense_created'),
  jsonb_build_object('expense_id', '5a000000-0000-0000-0000-000000000001'), 'activity row is redacted to the expense id');

-- B: cohost picks another member as payer; host assignment with a partial allocation
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select is(public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1200', 'host_assignment',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000001', 400, 0), pg_temp.it('5a100000-0000-0000-0000-000000000002', 800, 1)),
    jsonb_build_array(pg_temp.al('5a100000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 400)))),
  '5a000000-0000-0000-0000-000000000002'::uuid, 'cohost saves an expense paid by another member');
reset role;
select row_eq($$select creator_user_id, payer_user_id from public.expenses where id = '5a000000-0000-0000-0000-000000000002'$$,
  row('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid), 'cohost is creator and A is payer');
select is((select count(*)::int from public.expense_items where expense_id = '5a000000-0000-0000-0000-000000000002'), 2, 'items are stored');
select is((select source from public.allocations where expense_id = '5a000000-0000-0000-0000-000000000002'), 'cohost', 'cohost assignments are sourced as cohost');

-- C cannot edit B's expense or reuse its item ids
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1200', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1200))))$$,
  '22023', 'not_allowed', 'participant cannot edit an expense they did not create');
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '400', 'item_claim',
    jsonb_build_array(pg_temp.it('5a100000-0000-0000-0000-000000000001', 400, 0)), '[]'))$$,
  '22023', 'duplicate_item_id', 'item id owned by another expense is rejected');
reset role;

-- D: outsider
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.exp('5a000000-0000-0000-0000-000000000006', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '100', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 100))))$$,
  '22023', 'not_event_member', 'non-member cannot save an expense');
reset role;

-- Open-event trigger: no expense/item/allocation writes once the event leaves 'open'.
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('5a000000-0000-0000-0000-000000000004', '5ae00000-0000-0000-0000-000000000002',
  'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Taxi', current_date, 500, 'item_claim');
insert into public.expense_items (id, expense_id, description, total_cents)
values ('5a100000-0000-0000-0000-000000000006', '5a000000-0000-0000-0000-000000000004', 'Ride', 500);
insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source)
values ('5a000000-0000-0000-0000-000000000004', '5a100000-0000-0000-0000-000000000006', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 500, 'self_claim');
update public.events set state = 'settled' where id = '5ae00000-0000-0000-0000-000000000002';
-- Clients can no longer write items/expense columns directly, so these run as the server role.
select throws_ok($$insert into public.expense_items (id, expense_id, description, total_cents)
    values ('5a100000-0000-0000-0000-000000000007', '5a000000-0000-0000-0000-000000000004', 'x', 1)$$,
  '22023', 'event_not_open', 'items cannot be added after settlement');
select throws_ok($$update public.expenses set description = 'Bus' where id = '5a000000-0000-0000-0000-000000000004'$$,
  '22023', 'event_not_open', 'expense cannot be edited after settlement');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$delete from public.expenses where id = '5a000000-0000-0000-0000-000000000004'$$,
  '22023', 'event_not_open', 'creator cannot delete an expense after settlement');
reset role;
select throws_ok($$delete from public.allocations where expense_id = '5a000000-0000-0000-0000-000000000004'$$,
  '22023', 'event_not_open', 'allocations cannot be removed after settlement, even by the server role');
select lives_ok($$delete from public.events where id = '5ae00000-0000-0000-0000-000000000002'$$,
  'deleting a settled event still cascades through the trigger');
select is((select count(*)::int from public.expense_items where expense_id = '5a000000-0000-0000-0000-000000000004'), 0,
  'event delete cascaded to expense items');

select * from finish();
rollback;
