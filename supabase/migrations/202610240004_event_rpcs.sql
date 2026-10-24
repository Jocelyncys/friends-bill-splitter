-- Anonymous event creation and joining. Clients cannot insert into events /
-- event_members directly; these security-definer RPCs are the only entry points.

create function public.create_event(name text, mode public.event_mode, currency text)
returns table(event_id uuid, invite_token text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(create_event.name);
  v_token text;
  v_event uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if create_event.currency is distinct from 'MYR' then
    raise exception 'unsupported_currency' using errcode = '22023';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_');
  v_token := translate(v_token, '=', '');

  insert into public.events (name, mode, currency, owner_user_id, invite_token_hash)
  values (v_name, create_event.mode, 'MYR', v_uid,
          encode(extensions.digest(v_token, 'sha256'), 'hex'))
  returning id into v_event;

  insert into public.event_members (event_id, user_id, display_name, role)
  values (v_event, v_uid, 'Owner', 'owner');

  return query select v_event, v_token;
end $$;

create function public.join_event(invite_token text, display_name text)
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

  return query select v_event;
end $$;

revoke execute on function public.create_event(text, public.event_mode, text) from public, anon;
revoke execute on function public.join_event(text, text) from public, anon;
grant execute on function public.create_event(text, public.event_mode, text) to authenticated;
grant execute on function public.join_event(text, text) to authenticated;
