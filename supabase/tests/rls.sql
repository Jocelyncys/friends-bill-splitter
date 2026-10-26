begin;
select plan(375);

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
select policies_are('public', 'payment_events', array['transfer_parties_read_payment_events'], 'payment_events policies are exact');
select policies_are('public', 'expense_adjustments', array['members_read_expense_adjustments'], 'expense_adjustments policies are exact');

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
  12, 'RLS is enabled on all 12 public tables');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'),
  12, 'there are exactly 12 public tables');

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
    and tablename in ('allocations','settlements','settlement_balances','settlement_transfers','activity_log','payment_events','expense_adjustments')
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
insert into public.settlement_transfers (settlement_id, payer_user_id, receiver_user_id, amount_cents, ordinal)
values ('f2000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500, 1);
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
select throws_ok($$select public.delete_expense('5a000000-0000-0000-0000-000000000004')$$,
  '22023', 'event_not_open', 'creator cannot delete an expense after settlement');
reset role;
select throws_ok($$delete from public.allocations where expense_id = '5a000000-0000-0000-0000-000000000004'$$,
  '22023', 'event_not_open', 'allocations cannot be removed after settlement, even by the server role');
select lives_ok($$delete from public.events where id = '5ae00000-0000-0000-0000-000000000002'$$,
  'deleting a settled event still cascades through the trigger');
select is((select count(*)::int from public.expense_items where expense_id = '5a000000-0000-0000-0000-000000000004'), 0,
  'event delete cascaded to expense items');

-- Task 7a: claim / unclaim / assign / close-claiming / role RPCs + realtime ---
select is((select count(*)::int from unnest(array[
    'public.claim_item(uuid)', 'public.unclaim_item(uuid)', 'public.assign_item(uuid, uuid[])',
    'public.set_claiming_closed(uuid, boolean)', 'public.set_member_role(uuid, uuid, public.event_role)']) as f(sig)
  where has_function_privilege('anon', f.sig, 'execute')), 0, 'anon cannot execute any claim/role RPC');
select is((select count(*)::int from unnest(array[
    'public.claim_item(uuid)', 'public.unclaim_item(uuid)', 'public.assign_item(uuid, uuid[])',
    'public.set_claiming_closed(uuid, boolean)', 'public.set_member_role(uuid, uuid, public.event_role)']) as f(sig)
  where has_function_privilege('authenticated', f.sig, 'execute')), 5, 'authenticated can execute the claim/role RPCs');
select is((select count(*)::int from unnest(array['public.resplit_item_claims(uuid)', 'public.lock_item_expense(uuid, uuid)']) as f(sig)
  where has_function_privilege('authenticated', f.sig, 'execute') or has_function_privilege('anon', f.sig, 'execute')),
  0, 'clients cannot execute the internal claim helpers');
select is((select array_agg(tablename::text order by tablename) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'),
  array['events'], 'only public.events is published to realtime (DELETE payloads bypass RLS)');

-- F: a second participant in the seed event.
insert into auth.users (id, instance_id, aud, role)
values ('ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into public.event_members (event_id, user_id, display_name, role)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'F', 'participant');
create temp table rev7 (n bigint);
grant all on rev7 to public;

-- C creates an item_claim expense X1: I1 = 1001, I2 = 500.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.save_expense(pg_temp.exp('7a000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1501', 'item_claim',
    jsonb_build_array(pg_temp.it('7a100000-0000-0000-0000-000000000001', 1001, 0), pg_temp.it('7a100000-0000-0000-0000-000000000002', 500, 1)), '[]'))$$,
  'participant creates an item_claim expense');
reset role;
insert into rev7 select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000001')$$, 'participant claims an item');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = '7a100000-0000-0000-0000-000000000001' order by 1$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 1001::bigint, 'self_claim')$$,
  'a sole claimer gets the full item amount as self_claim');
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), (select n + 1 from rev7),
  'claim bumps the event revision');
select is((select metadata from public.activity_log where action = 'item_claimed' order by id desc limit 1),
  jsonb_build_object('expense_id', '7a000000-0000-0000-0000-000000000001', 'item_id', '7a100000-0000-0000-0000-000000000001'),
  'claim activity is redacted to ids');
update rev7 set n = (select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000001')$$, 'claiming twice is accepted');
reset role;
select is((select count(*)::int from public.allocations where item_id = '7a100000-0000-0000-0000-000000000001'), 1,
  'a repeated claim leaves one allocation');
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), (select n from rev7),
  'a repeated claim is a no-op');

-- A shares I1 with C: 1001 -> 501 / 500, extra cent to the lower participant id.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000001')$$, 'a second member claims the same item');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = '7a100000-0000-0000-0000-000000000001' order by 1$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 501::bigint, 'self_claim'), ('cccccccc-cccc-cccc-cccc-cccccccccccc', 500::bigint, 'self_claim')$$,
  'a shared item is re-split equally and every cent is kept');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.unclaim_item('7a100000-0000-0000-0000-000000000001')$$, 'a claimer unclaims');
select lives_ok($$select public.unclaim_item('7a100000-0000-0000-0000-000000000001')$$, 'unclaiming twice is accepted');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = '7a100000-0000-0000-0000-000000000001' order by 1$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 1001::bigint, 'self_claim')$$,
  'unclaim re-splits the item among the remaining claimers');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.claim_item('5a100000-0000-0000-0000-000000000001')$$,
  '22023', 'not_claimable', 'items of a non item_claim expense cannot be self-claimed');
select throws_ok($$select public.claim_item('7a100000-0000-0000-0000-0000000000ff')$$,
  '22023', 'item_not_found', 'claiming a missing item is rejected');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select throws_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000001')$$,
  '22023', 'item_not_found', 'a non-member cannot claim (the item stays hidden)');
reset role;

-- F: participant who did not create X1.
set local role authenticated;
set local request.jwt.claims = '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}';
select throws_ok($$select public.set_claiming_closed('7a000000-0000-0000-0000-000000000001', true)$$,
  '22023', 'not_allowed', 'a non-creator participant cannot close claiming');
select throws_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000002', array['cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[])$$,
  '22023', 'not_allowed', 'a participant cannot assign another person');
reset role;

-- C (creator) closes claiming, then still assigns.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.set_claiming_closed('7a000000-0000-0000-0000-000000000001', true)$$, 'the creator closes claiming on their own expense');
select throws_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000002')$$,
  '22023', 'claiming_closed', 'participants cannot claim after closing');
select throws_ok($$select public.unclaim_item('7a100000-0000-0000-0000-000000000001')$$,
  '22023', 'claiming_closed', 'participants cannot unclaim after closing');
select throws_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000002', array['dddddddd-dddd-dddd-dddd-dddddddddddd']::uuid[])$$,
  '22023', 'not_member', 'the creator cannot assign a non-member');
select lives_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000002', array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[])$$,
  'the creator assigns an item on their own expense after closing');
reset role;
select is((select claiming_closed from public.expenses where id = '7a000000-0000-0000-0000-000000000001'), true, 'claiming is closed');
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = '7a100000-0000-0000-0000-000000000002' order by 1$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500::bigint, 'expense_creator')$$,
  'a creator assignment gives the full item to the assignee');

-- B: cohost assigns on someone else's expense.
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select throws_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000001', array['dddddddd-dddd-dddd-dddd-dddddddddddd']::uuid[])$$,
  '22023', 'not_member', 'managers cannot assign a non-member');
select lives_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000001', array['ffffffff-ffff-ffff-ffff-ffffffffffff']::uuid[])$$,
  'a cohost assigns an item of another member''s expense');
select lives_ok($$select public.set_claiming_closed('7a000000-0000-0000-0000-000000000001', false)$$, 'a cohost reopens claiming');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = '7a100000-0000-0000-0000-000000000001' order by 1$$,
  $$values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 1001::bigint, 'cohost')$$,
  'an assignment replaces the item allocations, including self-claims');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000001')$$,
  '22023', 'not_claimable', 'an assigned item cannot be self-claimed');
reset role;

-- Roles.
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select throws_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cohost')$$,
  '22023', 'not_allowed', 'a cohost cannot promote roles');
select throws_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'participant')$$,
  '22023', 'not_allowed', 'a cohost cannot demote the owner');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cohost')$$,
  '22023', 'not_allowed', 'a participant cannot change roles');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cohost')$$,
  'the owner promotes a participant to cohost');
select is((select role::text from public.event_members where event_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  'cohost', 'the participant is now a cohost');
select lives_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'participant')$$,
  'the owner demotes the cohost back');
select throws_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'participant')$$,
  '22023', 'invalid_role_change', 'the owner row can never be changed');
select throws_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'owner')$$,
  '22023', 'invalid_role_change', 'no one can be made owner');
select throws_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'cohost')$$,
  '22023', 'not_member', 'only members can get a role');
reset role;
select results_eq($$select user_id::text, role::text from public.event_members
    where event_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and role <> 'participant' order by 1$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cohost')$$,
  'roles end as owner A and cohost B only');
select is((select metadata from public.activity_log where action = 'member_role_changed' order by id desc limit 1),
  jsonb_build_object('member_id', 'cccccccc-cccc-cccc-cccc-cccccccccccc'), 'role activity is redacted to ids');

-- Task 7b: revision + redacted activity for assign / close / role; owner source; cohost can close.
update rev7 set n = (select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000002', array['ffffffff-ffff-ffff-ffff-ffffffffffff']::uuid[])$$, 'the owner assigns an item');
reset role;
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), (select n + 1 from rev7), 'assign bumps the event revision');
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = '7a100000-0000-0000-0000-000000000002' order by 1$$,
  $$values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 500::bigint, 'owner')$$,
  'an owner assignment has source owner');
select is((select metadata from public.activity_log where action = 'item_assigned' order by id desc limit 1),
  jsonb_build_object('expense_id', '7a000000-0000-0000-0000-000000000001', 'item_id', '7a100000-0000-0000-0000-000000000002', 'member_ids', jsonb_build_array('ffffffff-ffff-ffff-ffff-ffffffffffff')),
  'assign activity is redacted to ids');
update rev7 set n = (select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select lives_ok($$select public.set_claiming_closed('7a000000-0000-0000-0000-000000000001', true)$$, 'a cohost can close claiming');
reset role;
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), (select n + 1 from rev7), 'close bumps the event revision');
select is((select metadata from public.activity_log where action = 'claiming_closed' order by id desc limit 1),
  jsonb_build_object('expense_id', '7a000000-0000-0000-0000-000000000001'), 'close activity is redacted to the expense id');
update rev7 set n = (select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'cohost')$$, 'the owner promotes F');
reset role;
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), (select n + 1 from rev7), 'a role change bumps the event revision');
select is((select metadata from public.activity_log where action = 'member_role_changed' order by id desc limit 1),
  jsonb_build_object('member_id', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), 'role activity names only the member id');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.set_member_role('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'participant')$$, 'the owner demotes F again');
select lives_ok($$select public.set_claiming_closed('7a000000-0000-0000-0000-000000000001', false)$$, 'the owner reopens claiming');
reset role;

-- Carry-forward: save_expense keeps self-claims of surviving items.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.save_expense(pg_temp.exp('7a000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1300', 'item_claim',
    jsonb_build_array(pg_temp.it('7a100000-0000-0000-0000-000000000031', 1000, 0), pg_temp.it('7a100000-0000-0000-0000-000000000032', 300, 1)), '[]'));
  select public.claim_item('7a100000-0000-0000-0000-000000000031');
  select public.claim_item('7a100000-0000-0000-0000-000000000032')$$,
  'the creator saves X3 and claims both items');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000031')$$, 'A shares item J1');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.exp('7a000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1300', 'item_claim',
    jsonb_build_array(pg_temp.it('7a100000-0000-0000-0000-000000000031', 1000, 0), pg_temp.it('7a100000-0000-0000-0000-000000000032', 300, 1)),
    jsonb_build_array(pg_temp.al('7a100000-0000-0000-0000-000000000031', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1000))))$$,
  '22023', 'item_has_claims', 'a save cannot also allocate an item that has self-claims');
select lives_ok($$select public.save_expense(pg_temp.exp('7a000000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '1001', 'item_claim',
    jsonb_build_array(jsonb_build_object('id', '7a100000-0000-0000-0000-000000000031', 'description', 'Satay', 'quantity', 1, 'total_cents', 1001, 'sort_order', 0)),
    '[]'))$$,
  'the creator renames J1, changes its amount and removes J2');
reset role;
select is((select description from public.expense_items where id = '7a100000-0000-0000-0000-000000000031'), 'Satay', 'the item was renamed');
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where expense_id = '7a000000-0000-0000-0000-000000000003' order by 1$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 501::bigint, 'self_claim'), ('cccccccc-cccc-cccc-cccc-cccccccccccc', 500::bigint, 'self_claim')$$,
  'claims survive an item rename and are re-split to the new item total; claims on the removed item are gone');

-- Task 7b: join_event and a direct expense delete bump the event revision.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('7be00000-0000-0000-0000-000000000001', 'Joinable', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  encode(extensions.digest('tok7b', 'sha256'), 'hex'));
insert into public.event_members (event_id, user_id, display_name, role)
values ('7be00000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner');
update rev7 set n = (select revision from public.events where id = '7be00000-0000-0000-0000-000000000001');
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select lives_ok($$select public.join_event('tok7b', 'Dee')$$, 'a user joins through the invite');
reset role;
select is((select revision from public.events where id = '7be00000-0000-0000-0000-000000000001'), (select n + 1 from rev7),
  'join_event bumps the event revision');
select is((select count(*)::int from public.event_members where event_id = '7be00000-0000-0000-0000-000000000001' and user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 1,
  'the joiner is a member');

update rev7 set n = (select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.delete_expense('7a000000-0000-0000-0000-000000000003')$$, 'the owner deletes an expense through delete_expense');
reset role;
select is((select revision from public.events where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'), (select n + 1 from rev7), 'an expense delete bumps the event revision exactly once');
select is((select metadata from public.activity_log where action = 'expense_deleted' order by id desc limit 1),
  jsonb_build_object('expense_id', '7a000000-0000-0000-0000-000000000003'), 'delete activity is redacted to the expense id');

-- Every RPC is rejected once the event is not open.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('7ae00000-0000-0000-0000-000000000009', 'Settled', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash7');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('7ae00000-0000-0000-0000-000000000009', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('7ae00000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('7a000000-0000-0000-0000-000000000009', '7ae00000-0000-0000-0000-000000000009',
  'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Kopi', current_date, 100, 'item_claim');
insert into public.expense_items (id, expense_id, description, total_cents)
values ('7a100000-0000-0000-0000-000000000009', '7a000000-0000-0000-0000-000000000009', 'Kopi', 100);
update public.events set state = 'settled' where id = '7ae00000-0000-0000-0000-000000000009';
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.claim_item('7a100000-0000-0000-0000-000000000009')$$, '22023', 'event_not_open', 'claim on a settled event is rejected');
select throws_ok($$select public.unclaim_item('7a100000-0000-0000-0000-000000000009')$$, '22023', 'event_not_open', 'unclaim on a settled event is rejected');
select throws_ok($$select public.set_claiming_closed('7a000000-0000-0000-0000-000000000009', true)$$, '22023', 'event_not_open', 'closing claiming on a settled event is rejected');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.assign_item('7a100000-0000-0000-0000-000000000009', array['cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[])$$, '22023', 'event_not_open', 'assign on a settled event is rejected');
select throws_ok($$select public.set_member_role('7ae00000-0000-0000-0000-000000000009', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cohost')$$, '22023', 'event_not_open', 'role change on a settled event is rejected');
reset role;

-- Task 9a: settlement confirmation and payment tracking ----------------------
select is((select count(*)::int from unnest(array[
    'public.confirm_settlement(uuid, public.settlement_method, uuid, bigint)', 'public.mark_payment_sent(uuid)',
    'public.confirm_payment_received(uuid)', 'public.override_payment_state(uuid, public.payment_state, text)',
    'public.get_receiver_details(uuid)']) as f(sig)
  where has_function_privilege('anon', f.sig, 'execute')), 0, 'anon cannot execute any settlement/payment RPC');
select is((select count(*)::int from unnest(array[
    'public.confirm_settlement(uuid, public.settlement_method, uuid, bigint)', 'public.mark_payment_sent(uuid)',
    'public.confirm_payment_received(uuid)', 'public.override_payment_state(uuid, public.payment_state, text)',
    'public.get_receiver_details(uuid)']) as f(sig)
  where has_function_privilege('authenticated', f.sig, 'execute')), 5, 'authenticated can execute the settlement/payment RPCs');
select is((select count(*)::int from unnest(array[
    'public.compute_settlement_balances(uuid)', 'public.compute_settlement_transfers(uuid, public.settlement_method, uuid)',
    'public.schedule_payment_details_cleanup(uuid)', 'public.apply_payment_transition(uuid, text, public.payment_state, text)']) as f(sig)
  where has_function_privilege('authenticated', f.sig, 'execute') or has_function_privilege('anon', f.sig, 'execute')),
  0, 'clients cannot execute the internal settlement helpers');
select is((select count(*)::int from unnest(array['public.settlements', 'public.settlement_balances',
    'public.settlement_transfers', 'public.payment_events']) as t(name)
  where has_table_privilege('authenticated', t.name, 'insert') or has_table_privilege('authenticated', t.name, 'update')
    or has_table_privilege('authenticated', t.name, 'delete')),
  0, 'clients have no insert/update/delete on settlement snapshot tables or payment_events');
select is((select has_column_privilege('authenticated', 'public.payment_details', 'delete_after', 'update')),
  false, 'clients cannot change payment_details.delete_after');

-- S1: the Task 8 fixture. ali = A (owner), ben = B (cohost), cara = C, dan = F; D is an outsider.
-- paid 80000/30000/0/0, owed 25000/20000/35000/30000.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('9ae00000-0000-0000-0000-000000000001', 'Trip', 'trip_event', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash9a1');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('9ae00000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Ali', 'owner'),
  ('9ae00000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Ben', 'cohost'),
  ('9ae00000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Cara', 'participant'),
  ('9ae00000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'Dan', 'participant');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method) values
  ('9a000000-0000-0000-0000-000000000011', '9ae00000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Hotel', current_date, 80000, 'custom'),
  ('9a000000-0000-0000-0000-000000000012', '9ae00000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Car', current_date, 30000, 'custom');
insert into public.allocations (expense_id, participant_user_id, amount_cents, source) values
  ('9a000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 25000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000011', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 35000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000011', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 20000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 20000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000012', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 10000, 'calculated');

-- Server recompute == src/domain/settlement.test.ts expected lists (order included).
select results_eq(
  $$select user_id, paid_cents, owed_cents, net_cents from public.compute_settlement_balances('9ae00000-0000-0000-0000-000000000001')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 80000::bigint, 25000::bigint, 55000::bigint),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 30000::bigint, 20000::bigint, 10000::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 0::bigint, 35000::bigint, -35000::bigint),
           ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 0::bigint, 30000::bigint, -30000::bigint)$$,
  'balances match calculateBalances for the Task 8 fixture');
select results_eq(
  $$select payer_user_id, receiver_user_id, amount_cents
    from public.compute_settlement_transfers('9ae00000-0000-0000-0000-000000000001', 'optimized_direct', null)$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 35000::bigint),
           ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 20000::bigint),
           ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 10000::bigint)$$,
  'optimized direct transfers match settleOptimizedDirect');
select results_eq(
  $$select payer_user_id, receiver_user_id, amount_cents
    from public.compute_settlement_transfers('9ae00000-0000-0000-0000-000000000001', 'coordinator', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 35000::bigint),
           ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 30000::bigint),
           ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 10000::bigint)$$,
  'coordinator(ali) transfers match settleViaCoordinator');

-- S2: the two-expense original-payer fixture (plus e3 with a zero share). ali = A, ben = B, cara = C.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('9ae00000-0000-0000-0000-000000000002', 'Payers', 'trip_event', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash9a2');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('9ae00000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Ali', 'owner'),
  ('9ae00000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Ben', 'participant'),
  ('9ae00000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Cara', 'participant');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method) values
  ('9a000000-0000-0000-0000-000000000021', '9ae00000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e1', current_date, 7500, 'custom'),
  ('9a000000-0000-0000-0000-000000000022', '9ae00000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'e2', current_date, 3000, 'custom'),
  ('9a000000-0000-0000-0000-000000000023', '9ae00000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'e3', current_date, 500, 'custom');
insert into public.allocations (expense_id, participant_user_id, amount_cents, source) values
  ('9a000000-0000-0000-0000-000000000021', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 2500, 'calculated'),
  ('9a000000-0000-0000-0000-000000000021', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 2500, 'calculated'),
  ('9a000000-0000-0000-0000-000000000021', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 2500, 'calculated'),
  ('9a000000-0000-0000-0000-000000000022', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000022', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000022', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1000, 'calculated'),
  ('9a000000-0000-0000-0000-000000000023', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 500, 'calculated'),
  ('9a000000-0000-0000-0000-000000000023', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0, 'calculated');
select results_eq(
  $$select payer_user_id, receiver_user_id, amount_cents
    from public.compute_settlement_transfers('9ae00000-0000-0000-0000-000000000002', 'original_payers', null)$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 1000::bigint),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 2500::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 3000::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 1000::bigint)$$,
  'original-payer transfers match settleOriginalPayers (opposite pairs not netted)');

-- S3: tied creditors (A, B +100 each) break ties by ascending id; F nets to zero; D has no expenses.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('9ae00000-0000-0000-0000-000000000003', 'Ties', 'trip_event', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash9a3');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('9ae00000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('9ae00000-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B', 'participant'),
  ('9ae00000-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant'),
  ('9ae00000-0000-0000-0000-000000000003', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'D', 'participant'),
  ('9ae00000-0000-0000-0000-000000000003', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'F', 'participant');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method) values
  ('9a000000-0000-0000-0000-000000000031', '9ae00000-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b', current_date, 100, 'custom'),
  ('9a000000-0000-0000-0000-000000000032', '9ae00000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a', current_date, 100, 'custom'),
  ('9a000000-0000-0000-0000-000000000033', '9ae00000-0000-0000-0000-000000000003', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'f', current_date, 50, 'custom');
insert into public.allocations (expense_id, participant_user_id, amount_cents, source) values
  ('9a000000-0000-0000-0000-000000000031', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 100, 'calculated'),
  ('9a000000-0000-0000-0000-000000000032', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 100, 'calculated'),
  ('9a000000-0000-0000-0000-000000000033', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 50, 'calculated');
select results_eq(
  $$select payer_user_id, receiver_user_id, amount_cents
    from public.compute_settlement_transfers('9ae00000-0000-0000-0000-000000000003', 'optimized_direct', null)$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 100::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 100::bigint)$$,
  'tied creditors are paid in ascending id order');

-- S4: no expenses, then an unresolved item_claim expense.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('9ae00000-0000-0000-0000-000000000004', 'Empty', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash9a4');
insert into public.event_members (event_id, user_id, display_name, role)
values ('9ae00000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner');

create temp table s9 (k text primary key, id uuid, n bigint);
grant all on s9 to public;
insert into s9 (k, n) select 'rev1', revision from public.events where id = '9ae00000-0000-0000-0000-000000000001';
insert into s9 (k, n) select 'rev4', revision from public.events where id = '9ae00000-0000-0000-0000-000000000004';

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000004', 'optimized_direct', null, (select n from s9 where k = 'rev4'))$$,
  '22023', 'no_expenses', 'an event without expenses cannot be settled');
reset role;
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('9a000000-0000-0000-0000-000000000041', '9ae00000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Kopi', current_date, 100, 'item_claim');
insert into public.expense_items (id, expense_id, description, total_cents)
values ('9a100000-0000-0000-0000-000000000041', '9a000000-0000-0000-0000-000000000041', 'Kopi', 100);
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000004', 'optimized_direct', null, (select n from s9 where k = 'rev4'))$$,
  '22023', 'unresolved_expenses', 'an expense with unallocated cents blocks settlement');
reset role;

-- S1 rejections.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'optimized_direct', null, (select n from s9 where k = 'rev1'))$$,
  '22023', 'not_allowed', 'a participant cannot confirm settlement');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'optimized_direct', null, (select n from s9 where k = 'rev1'))$$,
  '22023', 'not_allowed', 'an outsider cannot confirm settlement');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'optimized_direct', null, (select n - 1 from s9 where k = 'rev1'))$$,
  '40001', 'stale_revision', 'a stale expected revision is rejected');
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'coordinator', null, (select n from s9 where k = 'rev1'))$$,
  '22023', 'coordinator_required', 'coordinator mode needs a coordinator');
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'coordinator', 'cccccccc-cccc-cccc-cccc-cccccccccccc', (select n from s9 where k = 'rev1'))$$,
  '22023', 'coordinator_not_creditor', 'a debtor cannot coordinate');
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'coordinator', 'dddddddd-dddd-dddd-dddd-dddddddddddd', (select n from s9 where k = 'rev1'))$$,
  '22023', 'coordinator_not_creditor', 'a non-participant cannot coordinate');
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'optimized_direct', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (select n from s9 where k = 'rev1'))$$,
  '22023', 'invalid_payload', 'a coordinator is only accepted in coordinator mode');
reset role;
select is((select count(*)::int from public.settlements where event_id = '9ae00000-0000-0000-0000-000000000001'), 0,
  'rejected confirmations wrote no settlement');

-- B (cohost) confirms S1 via coordinator A.
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
insert into s9 (k, id) values ('s1', public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'coordinator',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (select n from s9 where k = 'rev1')));
select throws_ok($$select public.confirm_settlement('9ae00000-0000-0000-0000-000000000001', 'coordinator', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', (select n + 1 from s9 where k = 'rev1'))$$,
  '22023', 'already_settled', 'an event is settled only once');
reset role;
select row_eq($$select s.id, s.method::text, s.coordinator_user_id, s.confirmed_by from public.settlements s
    where s.event_id = '9ae00000-0000-0000-0000-000000000001'$$,
  row((select id from s9 where k = 's1'), 'coordinator'::text, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid),
  'one settlement row with method, coordinator and confirmer');
select results_eq($$select user_id, paid_cents, owed_cents, net_cents from public.settlement_balances
    where settlement_id = (select id from s9 where k = 's1') order by user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 80000::bigint, 25000::bigint, 55000::bigint),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 30000::bigint, 20000::bigint, 10000::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 0::bigint, 35000::bigint, -35000::bigint),
           ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 0::bigint, 30000::bigint, -30000::bigint)$$,
  'the balance snapshot is stored');
select results_eq($$select payer_user_id, receiver_user_id, amount_cents, state::text from public.settlement_transfers
    where settlement_id = (select id from s9 where k = 's1') order by payer_user_id::text collate "C", receiver_user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 10000::bigint, 'pending'::text),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 35000::bigint, 'pending'::text),
           ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 30000::bigint, 'pending'::text)$$,
  'the coordinator transfers are stored as pending');
select results_eq($$select ordinal, payer_user_id, receiver_user_id from public.settlement_transfers
    where settlement_id = (select id from s9 where k = 's1') order by ordinal$$,
  $$values (1, 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid),
           (2, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid),
           (3, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid)$$,
  'transfer ordinals keep the generation order of settleViaCoordinator');
select row_eq($$select state::text, settled_at is not null, revision from public.events where id = '9ae00000-0000-0000-0000-000000000001'$$,
  row('settled'::text, true, (select n + 1 from s9 where k = 'rev1')), 'the event is settled and its revision bumped');
select is((select metadata from public.activity_log where event_id = '9ae00000-0000-0000-0000-000000000001' and action = 'settlement_confirmed'),
  jsonb_build_object('settlement_id', (select id from s9 where k = 's1'), 'method', 'coordinator'),
  'settlement activity is redacted to ids and the method');
select throws_ok($$insert into public.allocations (expense_id, participant_user_id, amount_cents, source)
    values ('9a000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 'calculated')$$,
  '22023', 'event_not_open', 'expenses are read-only once settled');

-- S3 confirmed directly: zero-net participant F is in the snapshot, D (no expenses) is not.
insert into s9 (k, n) select 'rev3', revision from public.events where id = '9ae00000-0000-0000-0000-000000000003';
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
insert into s9 (k, id) values ('s3', public.confirm_settlement('9ae00000-0000-0000-0000-000000000003', 'optimized_direct', null,
  (select n from s9 where k = 'rev3')));
reset role;
select results_eq($$select user_id, net_cents from public.settlement_balances
    where settlement_id = (select id from s9 where k = 's3') order by user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 100::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 100::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, -200::bigint), ('ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid, 0::bigint)$$,
  'participants with zero net are snapshotted; members without expenses are not');

-- Payments on S1. t1 = A -> B, t2 = C -> A, t3 = F -> A.
insert into s9 (k, id) select 't1', id from public.settlement_transfers where settlement_id = (select id from s9 where k = 's1') and payer_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
insert into s9 (k, id) select 't2', id from public.settlement_transfers where settlement_id = (select id from s9 where k = 's1') and payer_user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
insert into s9 (k, id) select 't3', id from public.settlement_transfers where settlement_id = (select id from s9 where k = 's1') and payer_user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
create function pg_temp.t(p text) returns uuid language sql stable as $$ select id from s9 where k = p $$;
grant execute on function pg_temp.t(text) to public;

-- Receivers write their own payment details directly (insert, then update).
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$insert into public.payment_details (event_id, receiver_user_id, preferred_method, account_number, qr_storage_path)
    values ('9ae00000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bank', '9999000011112222',
      '9ae00000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/11111111-1111-1111-1111-111111111111')$$,
  'a receiver inserts their own payment details');
select is(pg_temp.upd_count($q$update public.payment_details set bank_name = 'Maybank', account_holder_name = 'Ali'
    where event_id = '9ae00000-0000-0000-0000-000000000001' and receiver_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$q$),
  1, 'a receiver updates their own payment details');
select throws_ok($$update public.payment_details set delete_after = null where event_id = '9ae00000-0000-0000-0000-000000000001'$$,
  '42501', null, 'a receiver cannot change delete_after');
select throws_ok($$insert into public.payment_details (event_id, receiver_user_id, preferred_method, account_number, delete_after)
    values ('9ae00000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bank', '1', now())$$,
  '42501', null, 'a receiver cannot insert delete_after');
select throws_ok($$insert into public.payment_details (event_id, receiver_user_id, preferred_method, account_number)
    values ('9ae00000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bank', '1')$$,
  '42501', null, 'nobody writes another receiver details');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select lives_ok($$insert into public.payment_details (event_id, receiver_user_id, preferred_method, account_number)
    values ('9ae00000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bank', '5555')$$,
  'a second receiver inserts their details');
reset role;

-- Receiver details: payer, receiver and managers only.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select results_eq($$select receiver_user_id, preferred_method, bank_name, account_holder_name, account_number, payment_reference, qr_storage_path
    from public.get_receiver_details(pg_temp.t('t2'))$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bank'::text, 'Maybank'::text, 'Ali'::text, '9999000011112222'::text, null::text,
    '9ae00000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/11111111-1111-1111-1111-111111111111'::text)$$,
  'the payer gets the receiver details and QR path');
select throws_ok($$select * from public.get_receiver_details(pg_temp.t('t3'))$$, '22023', 'transfer_not_found',
  'a member who is not a party gets transfer_not_found');
select throws_ok($$select * from public.get_receiver_details('00000000-0000-0000-0000-000000000000')$$, '22023', 'transfer_not_found',
  'an unknown transfer gets transfer_not_found');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select is((select count(*)::int from public.get_receiver_details(pg_temp.t('t2'))), 1, 'a cohost can read receiver details');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select throws_ok($$select * from public.get_receiver_details(pg_temp.t('t2'))$$, '22023', 'transfer_not_found', 'an outsider gets transfer_not_found');
reset role;

-- t2 (C -> A): wrong party and invalid state.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.mark_payment_sent(pg_temp.t('t2'))$$, '22023', 'not_allowed', 'the receiver cannot mark a payment sent');
select throws_ok($$select public.confirm_payment_received(pg_temp.t('t2'))$$, '22023', 'invalid_transition', 'a pending payment cannot be confirmed received');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.confirm_payment_received(pg_temp.t('t2'))$$, '22023', 'not_allowed', 'the payer cannot confirm receipt');
select throws_ok($$select public.mark_payment_sent(pg_temp.t('t3'))$$, '22023', 'transfer_not_found', 'a non-party cannot mark another transfer sent');
insert into s9 (k, n) select 'rev1b', revision from public.events where id = '9ae00000-0000-0000-0000-000000000001';
-- pending -> sent by the payer, idempotent.
select lives_ok($$select public.mark_payment_sent(pg_temp.t('t2'))$$, 'the payer marks the payment sent');
select lives_ok($$select public.mark_payment_sent(pg_temp.t('t2'))$$, 'marking sent again is idempotent');
reset role;
select is((select state::text from public.settlement_transfers where id = pg_temp.t('t2')), 'sent', 'the transfer is sent');
select results_eq($$select actor_user_id, old_state::text, new_state::text, reason from public.payment_events where transfer_id = pg_temp.t('t2')$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'pending'::text, 'sent'::text, null::text)$$,
  'one payment event with actor and states; the repeat added none');
select is((select revision from public.events where id = '9ae00000-0000-0000-0000-000000000001'), (select n + 1 from s9 where k = 'rev1b'),
  'a transition bumps the revision once');
-- sent -> confirmed by the receiver, idempotent.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.confirm_payment_received(pg_temp.t('t2'))$$, 'the receiver confirms receipt');
select lives_ok($$select public.confirm_payment_received(pg_temp.t('t2'))$$, 'confirming again is idempotent');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.mark_payment_sent(pg_temp.t('t2'))$$, '22023', 'invalid_transition', 'a confirmed payment cannot go back to sent');
select is((select count(*)::int from public.payment_events), 2, 'a payer sees the payment events of their own transfer');
select throws_ok($$insert into public.payment_events (transfer_id, actor_user_id, old_state, new_state)
    values (pg_temp.t('t2'), 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'pending', 'confirmed')$$,
  '42501', null, 'clients cannot write payment events');
reset role;
select results_eq($$select actor_user_id, old_state::text, new_state::text from public.payment_events where transfer_id = pg_temp.t('t2') order by id$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'pending'::text, 'sent'::text),
           ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'sent'::text, 'confirmed'::text)$$,
  'sent -> confirmed recorded by the receiver');

-- t3 (F -> A): override by a manager only, with a valid reason, only to confirmed.
set local role authenticated;
set local request.jwt.claims = '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}';
select throws_ok($$select public.override_payment_state(pg_temp.t('t3'), 'confirmed', 'paid')$$, '22023', 'not_allowed', 'a participant payer cannot override');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select throws_ok($$select public.override_payment_state(pg_temp.t('t3'), 'confirmed', '   ')$$, '22023', 'invalid_reason', 'a blank override reason is rejected');
select throws_ok($$select public.override_payment_state(pg_temp.t('t3'), 'confirmed', null)$$, '22023', 'invalid_reason', 'a missing override reason is rejected');
select throws_ok($$select public.override_payment_state(pg_temp.t('t3'), 'confirmed', repeat('x', 501))$$, '22023', 'invalid_reason', 'an override reason over 500 characters is rejected');
select throws_ok($$select public.override_payment_state(pg_temp.t('t3'), 'sent', 'paid')$$, '22023', 'invalid_transition', 'override only targets confirmed');
select lives_ok($$select public.override_payment_state(pg_temp.t('t3'), 'confirmed', '  Paid in cash  ')$$, 'a cohost overrides pending -> confirmed');
select lives_ok($$select public.override_payment_state(pg_temp.t('t3'), 'confirmed', 'again')$$, 'overriding again is idempotent');
reset role;
select results_eq($$select actor_user_id, old_state::text, new_state::text, reason from public.payment_events where transfer_id = pg_temp.t('t3')$$,
  $$values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'pending'::text, 'confirmed'::text, 'Paid in cash'::text)$$,
  'the override is recorded once with its trimmed reason');
select is((select count(*)::int from public.payment_details where event_id = '9ae00000-0000-0000-0000-000000000001' and delete_after is not null), 0,
  'payment details are kept while a transfer is unconfirmed');

-- t1 (A -> B): A marks sent, then the owner overrides sent -> confirmed; the event is fully paid.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.mark_payment_sent(pg_temp.t('t1'))$$, 'the coordinator marks their payout sent');
select lives_ok($$select public.override_payment_state(pg_temp.t('t1'), 'confirmed', 'Ben confirmed by phone')$$, 'the owner overrides sent -> confirmed');
reset role;
select is((select array_agg(distinct state::text) from public.settlement_transfers where settlement_id = pg_temp.t('s1')), array['confirmed'],
  'every transfer is confirmed');
select is((select count(*)::int from public.payment_details
    where event_id = '9ae00000-0000-0000-0000-000000000001' and delete_after = now() + interval '7 days'), 2,
  'payment details expire seven days after the event is fully paid');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$insert into public.payment_details (event_id, receiver_user_id, preferred_method, account_number)
    values ('9ae00000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bank', '777')$$,
  'a receiver can still add details after the event is fully paid');
select throws_ok($$select * from public.get_receiver_details(pg_temp.t('t2'))$$, '22023', 'not_allowed',
  'a payer whose transfer is confirmed can no longer read the receiver details');
select is((select count(*)::int from public.payment_details where receiver_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    and event_id = '9ae00000-0000-0000-0000-000000000001'), 0,
  'nor read them directly once nothing is owed');
reset role;
select is((select delete_after from public.payment_details where event_id = '9ae00000-0000-0000-0000-000000000001'
    and receiver_user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'), now() + interval '7 days',
  'details added after full payment get delete_after too');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select is((select count(*)::int from public.get_receiver_details(pg_temp.t('t2'))), 1,
  'the receiver still reads their own details after confirmation');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select is((select count(*)::int from public.get_receiver_details(pg_temp.t('t2'))), 1,
  'a cohost still reads receiver details after confirmation');
reset role;

-- S3 (still unpaid): no-row receiver details, owner override on a pending transfer.
insert into s9 (k, id) select 's3ca', id from public.settlement_transfers where settlement_id = (select id from s9 where k = 's3') and receiver_user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
insert into s9 (k, id) select 's3cb', id from public.settlement_transfers where settlement_id = (select id from s9 where k = 's3') and receiver_user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select is((select count(*)::int from public.get_receiver_details(pg_temp.t('s3cb'))), 0,
  'no row when the receiver has not entered details');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.override_payment_state(pg_temp.t('s3ca'), 'confirmed', 'Handed over in person')$$,
  'the owner overrides a pending transfer');
reset role;
select results_eq($$select actor_user_id, old_state::text, new_state::text from public.payment_events where transfer_id = pg_temp.t('s3ca')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'pending'::text, 'confirmed'::text)$$,
  'owner override pending -> confirmed is recorded');

-- Activity stays redacted: ids and states only, never bank numbers, QR paths or reasons.
select is((select count(*)::int from public.activity_log where event_id = '9ae00000-0000-0000-0000-000000000001'
    and action in ('payment_sent', 'payment_confirmed', 'payment_overridden')
    and (select array_agg(k order by k) from jsonb_object_keys(metadata) as k) = array['new_state', 'old_state', 'transfer_id']), 5,
  'payment activity rows hold only transfer id and states');
select is((select count(*)::int from public.activity_log where event_id = '9ae00000-0000-0000-0000-000000000001'
    and (metadata::text like '%9999000011112222%' or metadata::text like '%11111111-1111-1111-1111-111111111111%'
      or metadata::text like '%cash%')), 0,
  'no activity row contains a bank number, QR path or override reason');

-- payment_events visibility follows the transfer read policy.
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select is((select count(*)::int from public.payment_events), 0, 'an outsider sees no payment events');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select is((select count(*)::int from public.payment_events), 6, 'the owner sees every payment event (S1 and S3)');
reset role;

-- Payment RPCs need a settled event (the seed event has a transfer but is still open).
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.mark_payment_sent((select t.id from public.settlement_transfers t
    where t.settlement_id = 'f2000000-0000-0000-0000-000000000001'))$$, '22023', 'event_not_settled', 'payments need a settled event');
reset role;

-- Final fix (0009): delete_expense RPC, no direct DELETE, payment-qr bucket limits --
select is((select has_function_privilege('anon', 'public.delete_expense(uuid)', 'execute')), false, 'anon cannot execute delete_expense');
select is((select has_function_privilege('authenticated', 'public.delete_expense(uuid)', 'execute')), true, 'authenticated can execute delete_expense');
select is((select has_table_privilege('authenticated', 'public.expenses', 'delete')), false, 'clients cannot DELETE expenses directly');

insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('d9e00000-0000-0000-0000-000000000001', 'Deletes', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-d9');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('d9e00000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('d9e00000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B', 'cohost'),
  ('d9e00000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant'),
  ('d9e00000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'F', 'participant');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
select x.id::uuid, 'd9e00000-0000-0000-0000-000000000001', x.who::uuid, x.who::uuid, 'Lunch', current_date, 1000, 'equal'
from (values
  ('d9000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('d9000000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('d9000000-0000-0000-0000-000000000003', 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
  ('d9000000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc')) as x(id, who);
insert into public.allocations (expense_id, participant_user_id, amount_cents, source)
values ('d9000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 500, 'calculated'),
  ('d9000000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 500, 'calculated');

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000001')$$, '28000', 'not_authenticated', 'delete_expense needs a session');
set local request.jwt.claims = '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}';
select throws_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000001')$$, '22023', 'not_allowed', 'a participant cannot delete another person''s expense');
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select throws_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000001')$$, '22023', 'not_allowed', 'an outsider cannot delete an expense');
select throws_ok($$select public.delete_expense('d9000000-0000-0000-0000-0000000000ff')$$, '22023', 'not_allowed', 'a missing expense looks like not_allowed');
reset role;

update rev7 set n = (select revision from public.events where id = 'd9e00000-0000-0000-0000-000000000001');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000001')$$, 'the creator deletes their own expense');
reset role;
select is((select count(*)::int from public.expenses where id = 'd9000000-0000-0000-0000-000000000001'), 0, 'the expense is gone');
select is((select count(*)::int from public.allocations where expense_id = 'd9000000-0000-0000-0000-000000000001'), 0, 'its allocations are gone');
select is((select revision from public.events where id = 'd9e00000-0000-0000-0000-000000000001'), (select n + 1 from rev7),
  'delete_expense bumps the revision exactly once');
select is((select row(actor_user_id, metadata)::text from public.activity_log
    where event_id = 'd9e00000-0000-0000-0000-000000000001' and action = 'expense_deleted'),
  row('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, jsonb_build_object('expense_id', 'd9000000-0000-0000-0000-000000000001'))::text,
  'one redacted expense_deleted row with the caller as actor');

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select lives_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000003')$$, 'a co-host deletes another person''s expense');
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000002')$$, 'the owner deletes another person''s expense');
reset role;

update public.events set state = 'settled' where id = 'd9e00000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.delete_expense('d9000000-0000-0000-0000-000000000004')$$, '22023', 'event_not_open', 'no delete after settlement');
reset role;
select is((select count(*)::int from public.expenses where id = 'd9000000-0000-0000-0000-000000000004'), 1, 'the settled expense remains');

select is((select file_size_limit from storage.buckets where id = 'payment-qr'), 5242880::bigint, 'payment-qr accepts at most 5 MiB per object');
select is((select allowed_mime_types from storage.buckets where id = 'payment-qr'), array['image/png', 'image/jpeg', 'image/webp'],
  'payment-qr accepts only png, jpeg and webp');


-- Batch 2A (0010): multi-person assign_item, bill-level adjustments, owed shares --
select is((select has_function_privilege('anon', 'public.get_event_owed_shares(uuid)', 'execute')), false,
  'anon cannot execute get_event_owed_shares');
select is((select has_function_privilege('authenticated', 'public.get_event_owed_shares(uuid)', 'execute')), true,
  'authenticated can execute get_event_owed_shares');
select is((select count(*)::int from unnest(array['public.expense_owed_shares(uuid)']) as f(sig)
  where has_function_privilege('authenticated', f.sig, 'execute') or has_function_privilege('anon', f.sig, 'execute')),
  0, 'clients cannot execute expense_owed_shares');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assign_item'), 1, 'only the multi-member assign_item signature exists');
select ok(not has_table_privilege('authenticated', 'public.expense_adjustments', 'insert')
    and not has_table_privilege('authenticated', 'public.expense_adjustments', 'update')
    and not has_table_privilege('authenticated', 'public.expense_adjustments', 'delete')
    and not has_table_privilege('anon', 'public.expense_adjustments', 'select'),
  'clients cannot write expense_adjustments and anon cannot read them');

create function pg_temp.adj(p_id uuid, p_kind text, p_label text, p_amt bigint, p_sort int) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'kind', p_kind, 'label', p_label, 'amount_cents', p_amt, 'sort_order', p_sort) $$;
create function pg_temp.with_adj(p_base jsonb, p_adj jsonb) returns jsonb language sql as $$
  select p_base || jsonb_build_object('adjustments', p_adj) $$;
grant execute on function pg_temp.adj(uuid, text, text, bigint, int), pg_temp.with_adj(jsonb, jsonb) to public;

-- G: A owner, B cohost, C participant (creator of X), F participant; D outsider.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('b2ae0000-0000-0000-0000-000000000001', 'Multi', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-b2a1');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('b2ae0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('b2ae0000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B', 'cohost'),
  ('b2ae0000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant'),
  ('b2ae0000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'F', 'participant');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.save_expense(pg_temp.exp('b2000000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2201', 'item_claim',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000001', 1200, 0), pg_temp.it('b2100000-0000-0000-0000-000000000002', 1001, 1)), '[]',
    'b2ae0000-0000-0000-0000-000000000001'))$$,
  'C creates item_claim expense X (1200 + 1001)');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated"}';
select throws_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001',
    array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[])$$,
  '22023', 'not_allowed', 'a participant who did not create the expense cannot assign to several members');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001',
    array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'dddddddd-dddd-dddd-dddd-dddddddddddd']::uuid[])$$,
  '22023', 'not_member', 'every assignee must be a member');
select throws_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001',
    array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[])$$,
  '22023', 'invalid_payload', 'duplicate assignees are rejected');
select throws_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001', array[]::uuid[])$$,
  '22023', 'invalid_payload', 'an empty assignee list is rejected');
select throws_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001', null)$$,
  '22023', 'invalid_payload', 'a null assignee list is rejected');
select throws_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001',
    array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null]::uuid[])$$,
  '22023', 'invalid_payload', 'a null assignee is rejected');
reset role;
select is((select count(*)::int from public.allocations where item_id = 'b2100000-0000-0000-0000-000000000001'), 0,
  'rejected assignments wrote nothing');
update rev7 set n = (select revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000001');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select lives_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001',
    array['cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']::uuid[])$$,
  'the creator assigns one item to three members');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = 'b2100000-0000-0000-0000-000000000001' order by participant_user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 400::bigint, 'expense_creator'),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 400::bigint, 'expense_creator'),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc', 400::bigint, 'expense_creator')$$,
  '1200 assigned to three members is 400 each');
select is((select revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000001'), (select n + 1 from rev7),
  'a multi-member assignment bumps the revision exactly once');
select is((select metadata from public.activity_log where action = 'item_assigned' order by id desc limit 1),
  jsonb_build_object('expense_id', 'b2000000-0000-0000-0000-000000000001', 'item_id', 'b2100000-0000-0000-0000-000000000001',
    'member_ids', jsonb_build_array('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc')),
  'multi-assign activity is redacted to ids');

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select lives_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000002',
    array['ffffffff-ffff-ffff-ffff-ffffffffffff', 'cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[])$$,
  'a cohost assigns 1001 to two members');
select lives_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000001', array['ffffffff-ffff-ffff-ffff-ffffffffffff']::uuid[])$$,
  'a reassignment to one member replaces the three shares');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = 'b2100000-0000-0000-0000-000000000002' order by participant_user_id::text collate "C"$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 501::bigint, 'cohost'), ('ffffffff-ffff-ffff-ffff-ffffffffffff', 500::bigint, 'cohost')$$,
  '1001 to two members is 501/500, extra cent by ascending id');
select results_eq($$select participant_user_id::text, amount_cents from public.allocations
    where item_id = 'b2100000-0000-0000-0000-000000000001'$$,
  $$values ('ffffffff-ffff-ffff-ffff-ffffffffffff', 1200::bigint)$$,
  'reassigning replaces every previous share');

-- save_expense: an item may carry several equal shares.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.exp('b2000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1001', 'host_assignment',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000021', 1001, 0)),
    jsonb_build_array(pg_temp.al('b2100000-0000-0000-0000-000000000021', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500),
      pg_temp.al('b2100000-0000-0000-0000-000000000021', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 501)), 'b2ae0000-0000-0000-0000-000000000001'))$$,
  '22023', 'invalid_allocation', 'shares of a multi-assigned item must follow the equal-split cent rule');
select throws_ok($$select public.save_expense(pg_temp.exp('b2000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1001', 'host_assignment',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000021', 1001, 0)),
    jsonb_build_array(pg_temp.al('b2100000-0000-0000-0000-000000000021', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500)), 'b2ae0000-0000-0000-0000-000000000001'))$$,
  '22023', 'invalid_allocation', 'a partially assigned item is rejected');
select lives_ok($$select public.save_expense(pg_temp.exp('b2000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1001', 'host_assignment',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000021', 1001, 0)),
    jsonb_build_array(pg_temp.al('b2100000-0000-0000-0000-000000000021', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 500),
      pg_temp.al('b2100000-0000-0000-0000-000000000021', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 501)), 'b2ae0000-0000-0000-0000-000000000001'))$$,
  'host_assignment accepts one item shared by two members');
reset role;
select results_eq($$select participant_user_id::text, amount_cents, source from public.allocations
    where item_id = 'b2100000-0000-0000-0000-000000000021' order by participant_user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 501::bigint, 'owner'), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 500::bigint, 'owner')$$,
  'the shared host assignment is stored per assignee');

-- Adjustments: the user's receipt. Ali = A (payer), Ben = B; items 220 891 531 864 351 (2857),
-- voucher -500, SST +141, rounding +2, paid 2500. Ali has 220 + 891, Ben the rest.
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('b2ae0000-0000-0000-0000-000000000002', 'Receipt', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-b2a2');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('b2ae0000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Ali', 'owner'),
  ('b2ae0000-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Ben', 'participant'),
  ('b2ae0000-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Cara', 'participant');
create function pg_temp.receipt(p_total text, p_adj jsonb) returns jsonb language sql as $$
  select pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', p_total::jsonb, 'item_claim',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000011', 220, 0), pg_temp.it('b2100000-0000-0000-0000-000000000012', 891, 1),
      pg_temp.it('b2100000-0000-0000-0000-000000000013', 531, 2), pg_temp.it('b2100000-0000-0000-0000-000000000014', 864, 3),
      pg_temp.it('b2100000-0000-0000-0000-000000000015', 351, 4)),
    jsonb_build_array(pg_temp.al('b2100000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 220),
      pg_temp.al('b2100000-0000-0000-0000-000000000012', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 891),
      pg_temp.al('b2100000-0000-0000-0000-000000000013', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 531),
      pg_temp.al('b2100000-0000-0000-0000-000000000014', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 864),
      pg_temp.al('b2100000-0000-0000-0000-000000000015', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 351)),
    'b2ae0000-0000-0000-0000-000000000002'), p_adj) $$;
create function pg_temp.receipt_adj() returns jsonb language sql as $$
  select jsonb_build_array(
    pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', -500, 0),
    pg_temp.adj('b2200000-0000-0000-0000-000000000012', 'tax', 'SST 6%', 141, 1),
    pg_temp.adj('b2200000-0000-0000-0000-000000000013', 'rounding', 'Rounding', 2, 2)) $$;
grant execute on function pg_temp.receipt(text, jsonb), pg_temp.receipt_adj() to public;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.receipt('2501', pg_temp.receipt_adj()))$$,
  '22023', 'adjustment_mismatch', 'the paid total must equal items plus adjustments');
select throws_ok($$select public.save_expense(pg_temp.receipt('2857', pg_temp.receipt_adj()))$$,
  '22023', 'adjustment_mismatch', 'the items subtotal alone does not match once adjustments exist');
select throws_ok($$select public.save_expense(pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000019', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1000', 'equal', '[]',
    jsonb_build_array(pg_temp.al(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1000)), 'b2ae0000-0000-0000-0000-000000000002'),
    jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000019', 'tax', 'SST', 60, 0))))$$,
  '22023', 'adjustments_not_allowed', 'equal expenses take no adjustments');
select throws_ok($$select public.save_expense(pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000019', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1000', 'custom', '[]',
    jsonb_build_array(pg_temp.al(null, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1000)), 'b2ae0000-0000-0000-0000-000000000002'),
    jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000019', 'tax', 'SST', 60, 0))))$$,
  '22023', 'adjustments_not_allowed', 'custom expenses take no adjustments');
select throws_ok($$select public.save_expense(pg_temp.receipt('2857', jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', 0, 0))))$$,
  '22023', 'invalid_adjustment', 'a zero adjustment is rejected');
select throws_ok($$select public.save_expense(pg_temp.receipt('2357', jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'coupon', 'Voucher', -500, 0))))$$,
  '22023', 'invalid_adjustment', 'an unknown adjustment kind is rejected');
select throws_ok($$select public.save_expense(pg_temp.receipt('2357', jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', '  ', -500, 0))))$$,
  '22023', 'invalid_adjustment', 'a blank adjustment label is rejected');
select throws_ok($$select public.save_expense(pg_temp.receipt('2357', jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', repeat('x', 61), -500, 0))))$$,
  '22023', 'invalid_adjustment', 'an adjustment label over 60 characters is rejected');
select throws_ok($$select public.save_expense(pg_temp.receipt('2357', jsonb_build_array(jsonb_build_object('id', 'b2200000-0000-0000-0000-000000000011',
    'kind', 'discount', 'label', 'Voucher', 'amount_cents', '-500', 'sort_order', 0))))$$,
  '22023', 'invalid_adjustment', 'adjustment amounts must be JSON numbers');
select throws_ok($$select public.save_expense(pg_temp.receipt('2357', jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', -250, 0),
    pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', -250, 1))))$$,
  '22023', 'invalid_adjustment', 'duplicate adjustment ids are rejected');
select throws_ok($$select public.save_expense(pg_temp.receipt('2857', '{}'))$$,
  '22023', 'invalid_adjustment', 'adjustments must be an array');
update rev7 set n = (select revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000002');
select is(public.save_expense(pg_temp.receipt('2500', pg_temp.receipt_adj())), 'b2000000-0000-0000-0000-000000000011'::uuid,
  'the real receipt (items 2857, voucher -500, SST +141, rounding +2, paid 2500) is accepted');
reset role;
select is((select revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000002'), (select n + 1 from rev7),
  'saving with adjustments bumps the revision once');
select results_eq($$select id::text, kind, label, amount_cents, sort_order from public.expense_adjustments
    where expense_id = 'b2000000-0000-0000-0000-000000000011' order by sort_order$$,
  $$values ('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', -500::bigint, 0),
           ('b2200000-0000-0000-0000-000000000012', 'tax', 'SST 6%', 141::bigint, 1),
           ('b2200000-0000-0000-0000-000000000013', 'rounding', 'Rounding', 2::bigint, 2)$$,
  'adjustment rows are stored');
select is((select metadata from public.activity_log where event_id = 'b2ae0000-0000-0000-0000-000000000002' and action = 'expense_created'),
  jsonb_build_object('expense_id', 'b2000000-0000-0000-0000-000000000011'), 'activity stays redacted with adjustments');
select results_eq($$select participant_user_id::text, owed_cents from public.expense_owed_shares('b2000000-0000-0000-0000-000000000011') order by participant_user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 972::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1528::bigint)$$,
  'owed shares split the paid total proportionally: Ali 1111 -> 972, Ben 1746 -> 1528');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.save_expense(pg_temp.receipt('2500', pg_temp.receipt_adj()))$$,
  're-saving the receipt with the same adjustment ids is accepted');
reset role;
select results_eq($$select id::text, kind, label, amount_cents, sort_order from public.expense_adjustments
    where expense_id = 'b2000000-0000-0000-0000-000000000011' order by sort_order$$,
  $$values ('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', -500::bigint, 0),
           ('b2200000-0000-0000-0000-000000000012', 'tax', 'SST 6%', 141::bigint, 1),
           ('b2200000-0000-0000-0000-000000000013', 'rounding', 'Rounding', 2::bigint, 2)$$,
  'a re-save with the same adjustment ids is idempotent');

-- Another member's expense cannot reuse the adjustment ids.
set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000018', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '900', 'item_claim',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000018', 1000, 0)), '[]', 'b2ae0000-0000-0000-0000-000000000002'),
    jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000011', 'discount', 'Voucher', -100, 0))))$$,
  '22023', 'invalid_adjustment', 'an adjustment id owned by another expense is rejected');
reset role;

-- A shared item split three ways (host_assignment, payer B): items 1001 (A, B, C) + 700 (A) + 999 (B) = 2700,
-- tax +162, discount -300, paid 2562. Item sums A 1034, B 1333, C 333 -> owed 981 / 1265 / 316.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.save_expense(pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2562', 'host_assignment',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000031', 1001, 0), pg_temp.it('b2100000-0000-0000-0000-000000000032', 700, 1),
      pg_temp.it('b2100000-0000-0000-0000-000000000033', 999, 2)),
    jsonb_build_array(pg_temp.al('b2100000-0000-0000-0000-000000000031', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 334),
      pg_temp.al('b2100000-0000-0000-0000-000000000031', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 334),
      pg_temp.al('b2100000-0000-0000-0000-000000000031', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 333),
      pg_temp.al('b2100000-0000-0000-0000-000000000032', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 700),
      pg_temp.al('b2100000-0000-0000-0000-000000000033', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 999)),
    'b2ae0000-0000-0000-0000-000000000002'),
    jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000021', 'tax', 'Service tax', 162, 0),
      pg_temp.adj('b2200000-0000-0000-0000-000000000022', 'discount', 'Member discount', -300, 1))))$$,
  'the owner saves a host_assignment expense with a three-way shared item and adjustments');
reset role;
select results_eq($$select participant_user_id::text, owed_cents from public.expense_owed_shares('b2000000-0000-0000-0000-000000000012') order by participant_user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 981::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1265::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc', 316::bigint)$$,
  'a shared item counts toward each sharer''s subtotal: 1034/1333/333 of 2700 -> 981/1265/316 of 2562');

-- RLS: members read adjustments, outsiders do not, nobody writes them directly.
set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select is((select count(*)::int from public.expense_adjustments
    where expense_id in ('b2000000-0000-0000-0000-000000000011', 'b2000000-0000-0000-0000-000000000012')), 5,
  'a member reads the event''s adjustments');
select throws_ok($$insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
    values ('b2200000-0000-0000-0000-0000000000ff', 'b2000000-0000-0000-0000-000000000011', 'other', 'x', 1)$$,
  '42501', null, 'members cannot insert adjustments directly');
select throws_ok($$update public.expense_adjustments set amount_cents = 1 where expense_id = 'b2000000-0000-0000-0000-000000000011'$$,
  '42501', null, 'members cannot update adjustments directly');
select throws_ok($$delete from public.expense_adjustments where expense_id = 'b2000000-0000-0000-0000-000000000011'$$,
  '42501', null, 'members cannot delete adjustments directly');
select throws_ok($$select public.expense_owed_shares('b2000000-0000-0000-0000-000000000011')$$,
  '42501', null, 'members cannot call the internal owed-shares helper');
select results_eq($$select expense_id::text, payer_user_id::text, participant_user_id::text, owed_cents
    from public.get_event_owed_shares('b2ae0000-0000-0000-0000-000000000002')$$,
  $$values ('b2000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 972::bigint),
           ('b2000000-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1528::bigint),
           ('b2000000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 981::bigint),
           ('b2000000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1265::bigint),
           ('b2000000-0000-0000-0000-000000000012', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 316::bigint)$$,
  'get_event_owed_shares returns per-expense owed shares to a member, by expense then participant id');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated"}';
select is((select count(*)::int from public.expense_adjustments), 0, 'a non-member reads no adjustments');
select throws_ok($$select * from public.get_event_owed_shares('b2ae0000-0000-0000-0000-000000000002')$$,
  '22023', 'not_allowed', 'a non-member cannot read owed shares');
set local request.jwt.claims = '{"role":"authenticated"}';
select throws_ok($$select * from public.get_event_owed_shares('b2ae0000-0000-0000-0000-000000000002')$$,
  '28000', 'not_authenticated', 'get_event_owed_shares needs a session');
reset role;

-- Settlement uses owed shares. Paid A 2500, B 2562; owed A 1953, B 2793, C 316; net +547 / -231 / -316.
select results_eq(
  $$select user_id, paid_cents, owed_cents, net_cents from public.compute_settlement_balances('b2ae0000-0000-0000-0000-000000000002')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 2500::bigint, 1953::bigint, 547::bigint),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 2562::bigint, 2793::bigint, -231::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 0::bigint, 316::bigint, -316::bigint)$$,
  'balances use owed shares and sum to zero');
select results_eq(
  $$select payer_user_id, receiver_user_id, amount_cents
    from public.compute_settlement_transfers('b2ae0000-0000-0000-0000-000000000002', 'optimized_direct', null)$$,
  $$values ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 316::bigint),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 231::bigint)$$,
  'optimized direct transfers from owed shares match settleOptimizedDirect');
select results_eq(
  $$select payer_user_id, receiver_user_id, amount_cents
    from public.compute_settlement_transfers('b2ae0000-0000-0000-0000-000000000002', 'coordinator', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  $$values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 231::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 316::bigint)$$,
  'coordinator transfers from owed shares match settleViaCoordinator');

insert into s9 (k, n) select 'revb2', revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
insert into s9 (k, id) values ('sb2', public.confirm_settlement('b2ae0000-0000-0000-0000-000000000002', 'original_payers', null,
  (select n from s9 where k = 'revb2')));
reset role;
select results_eq($$select ordinal, payer_user_id, receiver_user_id, amount_cents from public.settlement_transfers
    where settlement_id = (select id from s9 where k = 'sb2') order by ordinal$$,
  $$values (1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 981::bigint),
           (2, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 1528::bigint),
           (3, 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 316::bigint)$$,
  'confirm_settlement (original payers) pays each payer the owed shares, matching settleOriginalPayers');
select results_eq($$select user_id, owed_cents, net_cents from public.settlement_balances
    where settlement_id = (select id from s9 where k = 'sb2') order by user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 1953::bigint, 547::bigint),
           ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, 2793::bigint, -231::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 316::bigint, -316::bigint)$$,
  'the settled snapshot stores owed shares');
select throws_ok($$insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
    values ('b2200000-0000-0000-0000-0000000000fe', 'b2000000-0000-0000-0000-000000000011', 'other', 'Late', 1)$$,
  '22023', 'event_not_open', 'adjustments are read-only once settled');

-- Unresolved check uses the items subtotal: items 500 + 500, voucher -500, paid 500, only the first
-- item assigned (500 allocated = paid total, but one item is still unallocated).
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('b2ae0000-0000-0000-0000-000000000003', 'Unresolved', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-b2a3');
insert into public.event_members (event_id, user_id, display_name, role)
values ('b2ae0000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner');
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.save_expense(pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000031', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '500', 'item_claim',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000041', 500, 0), pg_temp.it('b2100000-0000-0000-0000-000000000042', 500, 1)),
    jsonb_build_array(pg_temp.al('b2100000-0000-0000-0000-000000000041', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500)),
    'b2ae0000-0000-0000-0000-000000000003'),
    jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000031', 'discount', 'Voucher', -500, 0))))$$,
  'an item expense with one unallocated item and a voucher is saved');
select results_eq($$select participant_user_id::text, owed_cents from public.get_event_owed_shares('b2ae0000-0000-0000-0000-000000000003')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500::bigint)$$,
  'an unresolved expense reports raw allocations (no proportional split yet)');
select throws_ok($$select public.confirm_settlement('b2ae0000-0000-0000-0000-000000000003', 'optimized_direct', null,
    (select revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000003'))$$,
  '22023', 'unresolved_expenses', 'allocations equal to the paid total do not resolve an expense with unallocated items');
reset role;


-- Fix round 1: exact integer division, zero-subtotal guard, zero-weight fallback --------
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('b2ae0000-0000-0000-0000-000000000004', 'Bounds', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-b2a4');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('b2ae0000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('b2ae0000-0000-0000-0000-000000000004', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'B', 'participant'),
  ('b2ae0000-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant');
-- Near the JS safe-integer bound: weights 4503599627370494 / 4503599627370494 / 1 (9007199254740989),
-- rounding +2, paid 9007199254740991. allocateProportionally -> 4503599627370495 / 4503599627370495 / 1.
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('b2000000-0000-0000-0000-000000000041', 'b2ae0000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Big', current_date, 9007199254740991, 'host_assignment');
insert into public.expense_items (id, expense_id, description, total_cents) values
  ('b2100000-0000-0000-0000-000000000051', 'b2000000-0000-0000-0000-000000000041', 'x', 4503599627370494),
  ('b2100000-0000-0000-0000-000000000052', 'b2000000-0000-0000-0000-000000000041', 'y', 4503599627370494),
  ('b2100000-0000-0000-0000-000000000053', 'b2000000-0000-0000-0000-000000000041', 'z', 1);
insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source) values
  ('b2000000-0000-0000-0000-000000000041', 'b2100000-0000-0000-0000-000000000051', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 4503599627370494, 'owner'),
  ('b2000000-0000-0000-0000-000000000041', 'b2100000-0000-0000-0000-000000000052', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 4503599627370494, 'owner'),
  ('b2000000-0000-0000-0000-000000000041', 'b2100000-0000-0000-0000-000000000053', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1, 'owner');
insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
values ('b2200000-0000-0000-0000-000000000041', 'b2000000-0000-0000-0000-000000000041', 'rounding', 'Rounding', 2);
select results_eq($$select participant_user_id::text, owed_cents from public.expense_owed_shares('b2000000-0000-0000-0000-000000000041')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 4503599627370495::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 4503599627370495::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc', 1::bigint)$$,
  'proportional owed shares near 9e15 match allocateProportionally exactly');
select is((select sum(owed_cents) from public.expense_owed_shares('b2000000-0000-0000-0000-000000000041')), 9007199254740991::numeric,
  'owed shares near the bound sum to the paid total');

-- Three-way regression: weights 499999999 / 300000000 / 200000000, rounding +2, paid 1000000001.
-- allocateProportionally -> 500000000 / 300000001 / 200000000 (largest remainder goes to B).
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('b2000000-0000-0000-0000-000000000049', 'b2ae0000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Three way', current_date, 1000000001, 'host_assignment');
insert into public.expense_items (id, expense_id, description, total_cents) values
  ('b2100000-0000-0000-0000-000000000071', 'b2000000-0000-0000-0000-000000000049', 'a', 499999999),
  ('b2100000-0000-0000-0000-000000000072', 'b2000000-0000-0000-0000-000000000049', 'b', 300000000),
  ('b2100000-0000-0000-0000-000000000073', 'b2000000-0000-0000-0000-000000000049', 'c', 200000000);
insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source) values
  ('b2000000-0000-0000-0000-000000000049', 'b2100000-0000-0000-0000-000000000071', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 499999999, 'owner'),
  ('b2000000-0000-0000-0000-000000000049', 'b2100000-0000-0000-0000-000000000072', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 300000000, 'owner'),
  ('b2000000-0000-0000-0000-000000000049', 'b2100000-0000-0000-0000-000000000073', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 200000000, 'owner');
insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
values ('b2200000-0000-0000-0000-000000000049', 'b2000000-0000-0000-0000-000000000049', 'rounding', 'Rounding', 2);
select results_eq($$select participant_user_id::text, owed_cents from public.expense_owed_shares('b2000000-0000-0000-0000-000000000049')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 500000000::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 300000001::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc', 200000000::bigint)$$,
  'three-way proportional owed shares match allocateProportionally (largest remainder to B)');

-- Equal split near the bound: 9007199254740991 over three -> allocateEqual 3002399751580331 / ...330 / ...330.
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('b2000000-0000-0000-0000-000000000042', 'b2ae0000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Big2', current_date, 9007199254740991, 'host_assignment');
insert into public.expense_items (id, expense_id, description, total_cents)
values ('b2100000-0000-0000-0000-000000000054', 'b2000000-0000-0000-0000-000000000042', 'w', 9007199254740991);
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select lives_ok($$select public.assign_item('b2100000-0000-0000-0000-000000000054',
    array['cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']::uuid[])$$,
  'the owner assigns a near-bound item to three members');
select lives_ok($$select public.save_expense(pg_temp.exp('b2000000-0000-0000-0000-000000000043', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '9007199254740991', 'host_assignment',
    jsonb_build_array(jsonb_build_object('id', 'b2100000-0000-0000-0000-000000000055', 'description', 'v', 'quantity', 1, 'total_cents', 9007199254740991, 'sort_order', 0)),
    jsonb_build_array(
      jsonb_build_object('item_id', 'b2100000-0000-0000-0000-000000000055', 'participant_user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'amount_cents', 3002399751580331),
      jsonb_build_object('item_id', 'b2100000-0000-0000-0000-000000000055', 'participant_user_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'amount_cents', 3002399751580330),
      jsonb_build_object('item_id', 'b2100000-0000-0000-0000-000000000055', 'participant_user_id', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'amount_cents', 3002399751580330)),
    'b2ae0000-0000-0000-0000-000000000004'))$$,
  'save_expense accepts the allocateEqual split of a near-bound item');
reset role;
select results_eq($$select participant_user_id::text, amount_cents from public.allocations
    where item_id = 'b2100000-0000-0000-0000-000000000054' order by participant_user_id::text collate "C"$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 3002399751580331::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 3002399751580330::bigint),
           ('cccccccc-cccc-cccc-cccc-cccccccccccc', 3002399751580330::bigint)$$,
  'assign_item near 9e15 matches allocateEqual exactly');

-- All-zero item weights fall back to the equal rule: items cost 0, service +101, two sharers -> 51 / 50.
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('b2000000-0000-0000-0000-000000000044', 'b2ae0000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Free', current_date, 101, 'item_claim');
insert into public.expense_items (id, expense_id, description, total_cents)
values ('b2100000-0000-0000-0000-000000000056', 'b2000000-0000-0000-0000-000000000044', 'free', 0);
insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
values ('b2200000-0000-0000-0000-000000000044', 'b2000000-0000-0000-0000-000000000044', 'service', 'Service', 101);
insert into public.allocations (expense_id, item_id, participant_user_id, amount_cents, source) values
  ('b2000000-0000-0000-0000-000000000044', 'b2100000-0000-0000-0000-000000000056', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0, 'owner'),
  ('b2000000-0000-0000-0000-000000000044', 'b2100000-0000-0000-0000-000000000056', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 'owner');
select results_eq($$select participant_user_id::text, owed_cents from public.expense_owed_shares('b2000000-0000-0000-0000-000000000044')$$,
  $$values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 51::bigint), ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 50::bigint)$$,
  'all-zero item weights fall back to allocateEqual');

-- Zero-subtotal guard: adjustments need a positive items subtotal.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.with_adj(pg_temp.exp('b2000000-0000-0000-0000-000000000045', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '100', 'item_claim',
    jsonb_build_array(pg_temp.it('b2100000-0000-0000-0000-000000000057', 0, 0)), '[]', 'b2ae0000-0000-0000-0000-000000000004'),
    jsonb_build_array(pg_temp.adj('b2200000-0000-0000-0000-000000000045', 'service', 'Service', 100, 0))))$$,
  '22023', 'adjustments_need_items', 'adjustments on items that cost nothing are rejected');
reset role;

-- Defence in depth: an item expense with a positive total and no allocation rows is unresolved,
-- even when its items subtotal is 0 (rows written outside save_expense).
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('b2ae0000-0000-0000-0000-000000000005', 'ZeroItems', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-b2a5');
insert into public.event_members (event_id, user_id, display_name, role)
values ('b2ae0000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner');
insert into public.expenses (id, event_id, creator_user_id, payer_user_id, description, expense_date, total_cents, split_method)
values ('b2000000-0000-0000-0000-000000000051', 'b2ae0000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Zero', current_date, 100, 'item_claim');
insert into public.expense_items (id, expense_id, description, total_cents)
values ('b2100000-0000-0000-0000-000000000061', 'b2000000-0000-0000-0000-000000000051', 'free', 0);
insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
values ('b2200000-0000-0000-0000-000000000051', 'b2000000-0000-0000-0000-000000000051', 'service', 'Service', 100);
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
select throws_ok($$select public.confirm_settlement('b2ae0000-0000-0000-0000-000000000005', 'optimized_direct', null,
    (select revision from public.events where id = 'b2ae0000-0000-0000-0000-000000000005'))$$,
  '22023', 'unresolved_expenses', 'an expense with a positive total and no allocations is unresolved');
reset role;

-- Batch 2C (0011): one 'other' adjustment with a null label --
select ok((select is_nullable = 'YES' from information_schema.columns
    where table_schema = 'public' and table_name = 'expense_adjustments' and column_name = 'label'),
  'expense_adjustments.label is nullable');
insert into public.events (id, name, mode, owner_user_id, invite_token_hash)
values ('b2ce0000-0000-0000-0000-000000000001', 'Simple', 'single_bill', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hash-b2c1');
insert into public.event_members (event_id, user_id, display_name, role) values
  ('b2ce0000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A', 'owner'),
  ('b2ce0000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'C', 'participant'),
  ('b2ce0000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'F', 'participant');
create function pg_temp.simple(p_total text, p_adj jsonb) returns jsonb language sql as $$
  select pg_temp.with_adj(pg_temp.exp('b2c00000-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', p_total::jsonb, 'item_claim',
    jsonb_build_array(pg_temp.it('b2c10000-0000-0000-0000-000000000001', 2000, 0), pg_temp.it('b2c10000-0000-0000-0000-000000000002', 857, 1)),
    '[]', 'b2ce0000-0000-0000-0000-000000000001'), p_adj) $$;
grant execute on function pg_temp.simple(text, jsonb) to public;

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select throws_ok($$select public.save_expense(pg_temp.simple('2500', jsonb_build_array(pg_temp.adj('b2c20000-0000-0000-0000-000000000001', 'other', '', -357, 0))))$$,
  '22023', 'invalid_adjustment', 'an empty adjustment label is still rejected');
select throws_ok($$select public.save_expense(pg_temp.simple('2500', jsonb_build_array(pg_temp.adj('b2c20000-0000-0000-0000-000000000001', 'discount', null, -357, 0))))$$,
  '22023', 'invalid_adjustment', 'only kind other may leave the label out');
select throws_ok($$select public.save_expense(pg_temp.simple('2500', jsonb_build_array(pg_temp.adj('b2c20000-0000-0000-0000-000000000001', 'other', null, -356, 0))))$$,
  '22023', 'adjustment_mismatch', 'the single adjustment must still make items + adjustment = total');
select lives_ok($$select public.save_expense(pg_temp.simple('2500', jsonb_build_array(pg_temp.adj('b2c20000-0000-0000-0000-000000000001', 'other', null, -357, 0))))$$,
  'one other adjustment with a null label (amount paid 25.00 for items 28.57) is accepted');
reset role;
select results_eq($$select kind, label, amount_cents from public.expense_adjustments where expense_id = 'b2c00000-0000-0000-0000-000000000001'$$,
  $$values ('other'::text, null::text, -357::bigint)$$, 'the amount-paid difference is stored as one unlabelled other row');
select throws_ok($$insert into public.expense_adjustments (id, expense_id, kind, label, amount_cents)
    values ('b2c20000-0000-0000-0000-000000000009', 'b2c00000-0000-0000-0000-000000000001', 'other', '', 1)$$,
  '23514', null, 'the table still rejects an empty label');

select * from finish();
rollback;
