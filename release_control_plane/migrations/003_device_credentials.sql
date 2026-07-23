begin;

create table if not exists release_device_credentials (
  credential_id text primary key,
  binding_key text not null unique check (binding_key ~ '^[a-f0-9]{64}$'),
  tenant_id text not null,
  device_id text not null,
  surface_id text not null check (surface_id in ('android', 'browser_extension', 'desktop')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  idempotency_hash text not null check (idempotency_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status = 'active'),
  created_at timestamptz not null,
  event_order bigint generated always as identity
);

create index if not exists release_device_credentials_tenant_device
  on release_device_credentials (tenant_id, device_id, surface_id, created_at);

alter table release_device_credentials enable row level security;
alter table release_device_credentials force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
     where polname = 'release_device_credentials_tenant_isolation'
       and polrelid = 'release_device_credentials'::regclass
  ) then
    create policy release_device_credentials_tenant_isolation
      on release_device_credentials
      using (tenant_id = current_setting('moa.tenant_id', true))
      with check (tenant_id = current_setting('moa.tenant_id', true));
  end if;
end;
$$;

-- Device authentication starts with only an opaque credential hash, before a
-- tenant can be trusted for RLS. This exact-hash lookup is the sole
-- SECURITY DEFINER bridge; it returns no plaintext credential and cannot list.
create or replace function release_authenticate_device_credential(p_token_hash text)
returns table (
  credential_id text,
  binding_key text,
  tenant_id text,
  device_id text,
  surface_id text,
  token_hash text,
  idempotency_hash text,
  status text,
  created_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select c.credential_id, c.binding_key, c.tenant_id, c.device_id, c.surface_id,
         c.token_hash, c.idempotency_hash, c.status, c.created_at
    from public.release_device_credentials c
   where c.token_hash = p_token_hash
     and c.status = 'active'
   limit 1
$$;

revoke all on function release_authenticate_device_credential(text) from public;

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'release_device_credentials_append_only'
       and tgrelid = 'release_device_credentials'::regclass
       and not tgisinternal
  ) then
    create trigger release_device_credentials_append_only
      before update or delete or truncate on release_device_credentials
      for each statement execute function reject_release_control_mutation();
  end if;
end;
$$;

-- SELECT/INSERT on the table and EXECUTE on the exact-hash function are granted
-- to the dedicated application role outside this migration.

commit;
