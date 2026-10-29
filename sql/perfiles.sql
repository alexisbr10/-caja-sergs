-- Perfiles: Propietario (admin), Administrador operativo (cajero), Control documentario (documentario)

-- 1) Roles
update public.profiles set rol='documentario' where rol='lector';
alter table public.profiles drop constraint if exists profiles_rol_check;
alter table public.profiles add constraint profiles_rol_check
  check (rol in ('admin','cajero','documentario','pendiente','bloqueado'));

-- 2) Movimientos: el saldo solo lo puede calcular el propietario.
--    Los demás ven únicamente las salidas (detalle de gastos) y lo que ellos mismos registraron.
drop policy if exists mov_ver on public.movimientos;
drop policy if exists mov_crear on public.movimientos;
drop policy if exists mov_editar on public.movimientos;
drop policy if exists mov_borrar on public.movimientos;
create policy mov_ver on public.movimientos for select using (
  mi_rol() = 'admin'
  or (mi_rol() in ('cajero','documentario') and
      ((tipo='salida' and traspaso=false and ajuste=false) or uid = auth.uid()))
);
create policy mov_crear on public.movimientos for insert with check (
  mi_rol() = 'admin'
  or (mi_rol() = 'cajero' and traspaso=false and ajuste=false and uid = auth.uid())
);
create policy mov_editar on public.movimientos for update using (mi_rol()='admin') with check (mi_rol()='admin');
create policy mov_borrar on public.movimientos for delete using (mi_rol()='admin');

-- 3) Datos que revelan el saldo: solo propietario
drop policy if exists cie_ver on public.cierres;
create policy cie_ver on public.cierres for select using (mi_rol()='admin');
drop policy if exists arq_ver on public.arqueos;
drop policy if exists arq_crear on public.arqueos;
create policy arq_ver on public.arqueos for select using (mi_rol()='admin');
create policy arq_crear on public.arqueos for insert with check (mi_rol()='admin');
drop policy if exists cat_ver on public.catalogos;
create policy cat_ver on public.catalogos for select using (
  mi_rol()='admin' or (mi_rol() in ('cajero','documentario') and tipo in ('categoria','obra')));
drop policy if exists emp_ver on public.empresa;
create policy emp_ver on public.empresa for select using (mi_rol() in ('admin','cajero','documentario'));
drop policy if exists perfiles_ver on public.profiles;
create policy perfiles_ver on public.profiles for select using (
  id = auth.uid() or mi_rol() in ('admin','cajero','documentario'));

-- 4) Documentos (facturas/comprobantes subidos por Control documentario u operativo)
create table if not exists public.documentos (
  id text primary key,
  movimiento_id text,
  nombre text not null,
  ruta text not null,
  nota text,
  uid uuid default auth.uid(),
  creado bigint not null default ((extract(epoch from now())*1000)::bigint)
);
alter table public.documentos enable row level security;
drop policy if exists doc_ver on public.documentos;
drop policy if exists doc_crear on public.documentos;
drop policy if exists doc_borrar on public.documentos;
create policy doc_ver on public.documentos for select using (mi_rol() in ('admin','cajero','documentario'));
create policy doc_crear on public.documentos for insert with check (mi_rol() in ('admin','cajero','documentario') and uid = auth.uid());
create policy doc_borrar on public.documentos for delete using (mi_rol()='admin');

-- 5) Solicitudes de corrección o eliminación (requieren aprobación del propietario)
create table if not exists public.solicitudes (
  id text primary key,
  movimiento_id text not null,
  tipo text not null check (tipo in ('modificar','eliminar')),
  motivo text not null,
  cambios jsonb,
  resumen jsonb,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada')),
  uid uuid default auth.uid(),
  solicitante text,
  creado bigint not null default ((extract(epoch from now())*1000)::bigint),
  resuelto bigint,
  resuelto_por text,
  respuesta text
);
alter table public.solicitudes enable row level security;
drop policy if exists sol_ver on public.solicitudes;
drop policy if exists sol_crear on public.solicitudes;
create policy sol_ver on public.solicitudes for select using (
  mi_rol()='admin' or (mi_rol()='cajero' and uid = auth.uid()));
create policy sol_crear on public.solicitudes for insert with check (
  mi_rol() in ('admin','cajero') and uid = auth.uid() and estado='pendiente');

create or replace function public.log_solicitud() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.historial (accion, usuario, uid, detalle)
  values ('solicitud_nueva', public.nombre_actual(), auth.uid(),
          jsonb_build_object('tipo', new.tipo, 'motivo', new.motivo, 'concepto', new.resumen->>'concepto', 'importe', new.resumen->>'importe'));
  return new;
end $$;
drop trigger if exists sol_historial on public.solicitudes;
create trigger sol_historial after insert on public.solicitudes for each row execute function public.log_solicitud();

create or replace function public.resolver_solicitud(p_id text, p_aprobar boolean, p_resp text default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.solicitudes; m public.movimientos; c jsonb;
begin
  if public.mi_rol() is distinct from 'admin' then
    raise exception 'Solo el propietario puede resolver solicitudes' using errcode='42501';
  end if;
  select * into s from public.solicitudes where id = p_id for update;
  if not found or s.estado <> 'pendiente' then
    raise exception 'La solicitud ya fue resuelta o no existe' using errcode='P0001';
  end if;
  if p_aprobar then
    select * into m from public.movimientos where id = s.movimiento_id;
    if found then
      if s.tipo = 'eliminar' then
        update public.movimientos set anulado = true
          where id = m.id or (m.traspaso_id is not null and traspaso_id = m.traspaso_id);
      else
        c := coalesce(s.cambios, '{}'::jsonb);
        update public.movimientos set
          concepto     = coalesce(c->>'concepto', concepto),
          destinatario = coalesce(c->>'destinatario', destinatario),
          comprobante  = coalesce(c->>'comprobante', comprobante),
          metodo       = coalesce(c->>'metodo', metodo),
          comentario   = coalesce(c->>'comentario', comentario),
          categoria    = coalesce(c->>'categoria', categoria),
          obra         = coalesce(c->>'obra', obra),
          caja         = coalesce(c->>'caja', caja),
          fecha        = coalesce(c->>'fecha', fecha),
          importe      = coalesce((c->>'importe')::numeric, importe)
        where id = m.id;
      end if;
    end if;
  end if;
  update public.solicitudes set
    estado = case when p_aprobar then 'aprobada' else 'rechazada' end,
    resuelto = (extract(epoch from now())*1000)::bigint,
    resuelto_por = public.nombre_actual(),
    respuesta = nullif(p_resp,'')
  where id = p_id;
  insert into public.historial (accion, usuario, uid, detalle)
  values (case when p_aprobar then 'solicitud_aprobada' else 'solicitud_rechazada' end,
          public.nombre_actual(), auth.uid(),
          jsonb_build_object('tipo', s.tipo, 'concepto', s.resumen->>'concepto', 'solicitante', s.solicitante));
end $$;
revoke execute on function public.resolver_solicitud(text, boolean, text) from public, anon;
grant execute on function public.resolver_solicitud(text, boolean, text) to authenticated;
revoke execute on function public.log_solicitud() from public, anon, authenticated;

-- 6) Comprobantes (Storage)
drop policy if exists comp_subir on storage.objects;
drop policy if exists comp_ver on storage.objects;
create policy comp_subir on storage.objects for insert with check (
  bucket_id='comprobantes' and mi_rol() in ('admin','cajero','documentario'));
create policy comp_ver on storage.objects for select using (
  bucket_id='comprobantes' and mi_rol() in ('admin','cajero','documentario'));

-- 7) Actualización en vivo
do $$ begin
  begin alter publication supabase_realtime add table public.solicitudes; exception when others then null; end;
  begin alter publication supabase_realtime add table public.documentos; exception when others then null; end;
end $$;

-- Ajuste posterior: el Administrador operativo ve el saldo; Control documentario también registra movimientos (sin ver saldo).
drop policy if exists mov_ver on public.movimientos;
drop policy if exists mov_crear on public.movimientos;
create policy mov_ver on public.movimientos for select using (
  mi_rol() in ('admin','cajero')
  or (mi_rol() = 'documentario' and ((tipo='salida' and traspaso=false and ajuste=false) or uid = auth.uid())));
create policy mov_crear on public.movimientos for insert with check (
  mi_rol() = 'admin'
  or (mi_rol() in ('cajero','documentario') and traspaso=false and ajuste=false and uid = auth.uid()));
drop policy if exists cat_ver on public.catalogos;
create policy cat_ver on public.catalogos for select using (
  mi_rol() in ('admin','cajero') or (mi_rol() = 'documentario' and tipo in ('categoria','obra')));
drop policy if exists cat_crear on public.catalogos;
create policy cat_crear on public.catalogos for insert with check (
  mi_rol() = 'admin' or (mi_rol() in ('cajero','documentario') and tipo in ('categoria','obra')));

-- Matriz final: Control documentario solo ve lo que registra; el operativo ve historial y gestiona categorías/obras/mínimos.
drop policy if exists mov_ver on public.movimientos;
create policy mov_ver on public.movimientos for select using (
  mi_rol() in ('admin','cajero') or (mi_rol() = 'documentario' and uid = auth.uid()));
drop policy if exists his_ver on public.historial;
create policy his_ver on public.historial for select using (mi_rol() in ('admin','cajero'));
drop policy if exists cat_crear on public.catalogos;
drop policy if exists cat_editar on public.catalogos;
drop policy if exists cat_borrar on public.catalogos;
create policy cat_crear on public.catalogos for insert with check (
  mi_rol() in ('admin','cajero') or (mi_rol() = 'documentario' and tipo in ('categoria','obra')));
create policy cat_editar on public.catalogos for update using (mi_rol() in ('admin','cajero')) with check (mi_rol() in ('admin','cajero'));
create policy cat_borrar on public.catalogos for delete using (mi_rol() in ('admin','cajero'));
