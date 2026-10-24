insert into storage.buckets (id, name, public)
values ('payment-qr', 'payment-qr', false)
on conflict (id) do nothing;

-- Object names are <event-id>/<receiver-user-id>/<uuid>. Returns the segment as uuid,
-- or null when the path is malformed so a bad name never errors the query.
create function public.payment_qr_path_uuid(object_name text, segment int) returns uuid
language sql immutable set search_path = '' as $$
  select case
    when (storage.foldername(object_name))[segment] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (storage.foldername(object_name))[segment]::uuid
  end;
$$;

revoke execute on function public.payment_qr_path_uuid(text, int) from public, anon;
grant execute on function public.payment_qr_path_uuid(text, int) to authenticated;

create policy payment_qr_authorized_read on storage.objects for select to authenticated using (
  bucket_id = 'payment-qr'
  and public.payment_qr_path_uuid(name, 1) is not null
  and public.payment_qr_path_uuid(name, 2) is not null
  and (
    public.payment_qr_path_uuid(name, 2) = auth.uid()
    or public.owes_receiver(public.payment_qr_path_uuid(name, 1), public.payment_qr_path_uuid(name, 2))
    or public.has_event_role(public.payment_qr_path_uuid(name, 1), array['owner','cohost']::public.event_role[])
  )
);

create policy payment_qr_receiver_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'payment-qr'
  and public.payment_qr_path_uuid(name, 2) = auth.uid()
  and public.is_event_member(public.payment_qr_path_uuid(name, 1))
);

create policy payment_qr_receiver_update on storage.objects for update to authenticated
using (
  bucket_id = 'payment-qr'
  and public.payment_qr_path_uuid(name, 2) = auth.uid()
  and public.is_event_member(public.payment_qr_path_uuid(name, 1))
)
with check (
  bucket_id = 'payment-qr'
  and public.payment_qr_path_uuid(name, 2) = auth.uid()
  and public.is_event_member(public.payment_qr_path_uuid(name, 1))
);

create policy payment_qr_receiver_delete on storage.objects for delete to authenticated using (
  bucket_id = 'payment-qr'
  and public.payment_qr_path_uuid(name, 2) = auth.uid()
  and public.is_event_member(public.payment_qr_path_uuid(name, 1))
);
