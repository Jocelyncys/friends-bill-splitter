-- Host-added people ("guests").
--
-- An owner/co-host can add a person by name only, without inviting them. A guest is an
-- ordinary event_members row (is_guest = true) whose user_id is a random uuid that is not
-- an auth user, so everything that already works with member ids (payer, equal/custom
-- splits, item assignment, settlement) works for guests unchanged. Guests never sign in:
-- is_event_member / has_event_role compare with auth.uid(), so a guest id grants nothing.
--
-- - add_guest_member / remove_guest_member (owner/co-host, open event).
-- - invite_guests lists an open event's guests for someone holding the invite link, and
--   join_event takes an optional guest_id: the joiner takes over that guest (their items,
--   payments and place in the member list move to the joiner's account).
-- - Settlement: owners/co-hosts mark a guest's transfers as sent / received for them.
--
-- Errors: SQLSTATE 22023 with a machine key (not_allowed, event_not_open, invalid_display_name,
-- not_member, member_in_use, already_member, invalid_invite is P0002 as in join_event).

-- Member ids no longer have to be auth users ---------------------------------------------
-- Ids of people who take part in money (members, payers, shares, settlement) may be guests.
-- Ids of people who act (owner, expense creator, confirmed_by, actors, payment details
-- receivers) stay auth users.
alter table public.event_members drop constraint event_members_user_id_fkey;
alter table public.expenses drop constraint expenses_payer_user_id_fkey;
alter table public.allocations drop constraint allocations_participant_user_id_fkey;
alter table public.settlements drop constraint settlements_coordinator_user_id_fkey;
alter table public.settlement_balances drop constraint settlement_balances_user_id_fkey;
alter table public.settlement_transfers drop constraint settlement_transfers_payer_user_id_fkey;
alter table public.settlement_transfers drop constraint settlement_transfers_receiver_user_id_fkey;

alter table public.event_members add column is_guest boolean not null default false;
-- A guest cannot act, so it can never be a co-host or the owner.
alter table public.event_members add constraint event_members_guest_participant
  check (not is_guest or role = 'participant');

-- Clients still cannot write is_guest (only display_name is granted for update).

-- add_guest_member ------------------------------------------------------------------------
create function public.add_guest_member(event_id uuid, display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event uuid := add_guest_member.event_id;
  v_name text := btrim(add_guest_member.display_name);
  v_state public.event_state;
  v_role public.event_role;
  v_guest uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  -- Role read AFTER the event lock; a missing event and a non-manager look the same.
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null or v_role not in ('owner', 'cohost') then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if v_state is distinct from 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 40 then
    raise exception 'invalid_display_name' using errcode = '22023';
  end if;

  insert into public.event_members (event_id, user_id, display_name, role, is_guest)
  values (v_event, v_guest, v_name, 'participant', true);

  update public.events e set revision = e.revision + 1 where e.id = v_event;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, 'guest_added', jsonb_build_object('member_id', v_guest));

  return v_guest;
end $$;

-- remove_guest_member ---------------------------------------------------------------------
-- Only a guest that is not a payer and has no share in any expense can be removed.
create function public.remove_guest_member(event_id uuid, member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_event uuid := remove_guest_member.event_id;
  v_member uuid := remove_guest_member.member_id;
  v_state public.event_state;
  v_role public.event_role;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  select e.state into v_state from public.events e where e.id = v_event for update;
  select m.role into v_role from public.event_members m where m.event_id = v_event and m.user_id = v_uid;
  if v_role is null or v_role not in ('owner', 'cohost') then
    raise exception 'not_allowed' using errcode = '22023';
  end if;
  if v_state is distinct from 'open' then
    raise exception 'event_not_open' using errcode = '22023';
  end if;
  perform 1 from public.event_members m
  where m.event_id = v_event and m.user_id = v_member and m.is_guest
  for update;
  if not found then
    raise exception 'not_member' using errcode = '22023';
  end if;
  if exists(select 1 from public.expenses x where x.event_id = v_event and x.payer_user_id = v_member)
    or exists(select 1 from public.allocations a join public.expenses x on x.id = a.expense_id
      where x.event_id = v_event and a.participant_user_id = v_member) then
    raise exception 'member_in_use' using errcode = '22023';
  end if;

  delete from public.event_members m where m.event_id = v_event and m.user_id = v_member;

  update public.events e set revision = e.revision + 1 where e.id = v_event;
  insert into public.activity_log (event_id, actor_user_id, action, metadata)
  values (v_event, v_uid, 'guest_removed', jsonb_build_object('member_id', v_member));
end $$;

-- invite_guests ---------------------------------------------------------------------------
-- The guests of an open event, for the join page ("I'm one of these"). Anyone holding
-- the invite link may call it, before signing in. Names only, in join order.
create function public.invite_guests(invite_token text)
returns table(member_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, m.display_name
  from public.events e
  join public.event_members m on m.event_id = e.id and m.is_guest
  where e.invite_token_hash = encode(extensions.digest(coalesce(invite_guests.invite_token, ''), 'sha256'), 'hex')
    and e.state = 'open'
  order by m.joined_at, m.user_id;
$$;

-- join_event: as 0007, plus an optional guest to take over ----------------------------------
drop function public.join_event(text, text);

create function public.join_event(invite_token text, display_name text, guest_id uuid default null)
returns table(event_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(join_event.display_name);
  v_guest uuid := join_event.guest_id;
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
    and e.state = 'open'
  for update;
  if v_event is null then
    raise exception 'invalid_invite' using errcode = 'P0002';
  end if;

  if v_guest is null then
    insert into public.event_members as m (event_id, user_id, display_name, role)
    values (v_event, v_uid, v_name, 'participant')
    on conflict (event_id, user_id) do update set display_name = excluded.display_name;
  else
    perform 1 from public.event_members m
    where m.event_id = v_event and m.user_id = v_guest and m.is_guest
    for update;
    if not found then
      raise exception 'not_member' using errcode = '22023';
    end if;
    -- Merging two members' shares could collide on the same item; a member keeps their own.
    if exists(select 1 from public.event_members m where m.event_id = v_event and m.user_id = v_uid) then
      raise exception 'already_member' using errcode = '22023';
    end if;

    -- The event is open, so there is no settlement snapshot to move yet.
    update public.allocations a set participant_user_id = v_uid
    from public.expenses x
    where x.id = a.expense_id and x.event_id = v_event and a.participant_user_id = v_guest;
    update public.expenses x set payer_user_id = v_uid
    where x.event_id = v_event and x.payer_user_id = v_guest;
    -- Keeps joined_at, so the person keeps their place (and "Ali (2)" numbering) in the list.
    update public.event_members m set user_id = v_uid, display_name = v_name, is_guest = false
    where m.event_id = v_event and m.user_id = v_guest;

    insert into public.activity_log (event_id, actor_user_id, action, metadata)
    values (v_event, v_uid, 'guest_claimed', jsonb_build_object('member_id', v_guest));
  end if;

  update public.events e set revision = e.revision + 1 where e.id = v_event;

  return query select v_event;
end $$;

-- apply_payment_transition: as 0008, plus owners/co-hosts acting for a guest ---------------
-- A guest cannot sign in, so an owner/co-host marks a guest payer's transfer as sent and
-- confirms a transfer to a guest receiver as received.
create or replace function public.apply_payment_transition(p_transfer uuid, p_kind text, p_target public.payment_state, p_reason text)
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
    if v_uid <> v_transfer.payer_user_id
      and not (v_manager and exists(select 1 from public.event_members m
        where m.event_id = v_event and m.user_id = v_transfer.payer_user_id and m.is_guest)) then
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
    if v_uid <> v_transfer.receiver_user_id
      and not (v_manager and exists(select 1 from public.event_members m
        where m.event_id = v_event and m.user_id = v_transfer.receiver_user_id and m.is_guest)) then
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

-- Privileges --------------------------------------------------------------------------------
revoke execute on function public.apply_payment_transition(uuid, text, public.payment_state, text) from public, anon, authenticated;
revoke execute on function public.add_guest_member(uuid, text) from public, anon;
revoke execute on function public.remove_guest_member(uuid, uuid) from public, anon;
revoke execute on function public.join_event(text, text, uuid) from public, anon;
revoke execute on function public.invite_guests(text) from public;
grant execute on function public.add_guest_member(uuid, text) to authenticated;
grant execute on function public.remove_guest_member(uuid, uuid) to authenticated;
grant execute on function public.join_event(text, text, uuid) to authenticated;
-- The join page lists guests before the visitor has signed in.
grant execute on function public.invite_guests(text) to anon, authenticated;
