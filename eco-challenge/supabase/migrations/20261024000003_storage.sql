-- =====================================================================
-- SSOMA ECO CHALLENGE · 003 · Almacenamiento de imágenes del banco
-- Bucket público de sólo lectura; sólo el personal autorizado sube imágenes.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('residuos', 'residuos', true, 2097152,
        array['image/png', 'image/jpeg', 'image/webp'])  -- sin SVG: puede contener scripts
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists residuos_staff_insert on storage.objects;
create policy residuos_staff_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'residuos' and public.is_staff());

drop policy if exists residuos_staff_update on storage.objects;
create policy residuos_staff_update on storage.objects for update to authenticated
  using (bucket_id = 'residuos' and public.is_staff())
  with check (bucket_id = 'residuos' and public.is_staff());

drop policy if exists residuos_admin_delete on storage.objects;
create policy residuos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'residuos' and public.is_admin());
