begin;

alter table release_device_credentials
  add column if not exists application_id text not null default 'chief-moa',
  add column if not exists scopes text[] not null default array['release.read'],
  add column if not exists owner_id text;

create table if not exists device_enrollment_capabilities (
  capability_id text primary key,
  capability_hash text not null unique check (capability_hash ~ '^[a-f0-9]{64}$'),
  binding_key text not null check (binding_key ~ '^[a-f0-9]{64}$'),
  tenant_id text not null,
  owner_id text not null,
  device_id text not null,
  surface_id text not null check (surface_id in ('android', 'browser_extension', 'desktop')),
  application_id text not null check (application_id = 'ag.companion'),
  scopes text[] not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > issued_at),
  check (consumed_at is null or consumed_at >= issued_at)
);

create index if not exists device_enrollment_capabilities_expiry
  on device_enrollment_capabilities (expires_at) where consumed_at is null;

-- The capability hash is the pre-authentication authority. The function locks
-- one exact row and atomically burns it while inserting the hash-only device
-- credential. It cannot enumerate capabilities or expose either secret.
create or replace function exchange_device_enrollment_capability(
  p_capability_hash text,
  p_credential_hash text,
  p_exchanged_at timestamptz
)
returns table (
  error_code text,
  credential_id text,
  tenant_id text,
  owner_id text,
  device_id text,
  surface_id text,
  application_id text,
  scopes text[],
  created_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  capability device_enrollment_capabilities%rowtype;
  next_credential_id text := 'devc_' || substring(p_credential_hash from 1 for 32);
begin
  select * into capability
    from public.device_enrollment_capabilities
   where capability_hash = p_capability_hash
   for update;
  if not found then
    return query select 'invalid_enrollment_capability', null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::timestamptz;
    return;
  end if;
  if capability.consumed_at is not null then
    return query select 'enrollment_capability_consumed', null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::timestamptz;
    return;
  end if;
  if capability.expires_at < p_exchanged_at then
    return query select 'enrollment_capability_expired', null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::timestamptz;
    return;
  end if;
  perform set_config('moa.tenant_id', capability.tenant_id, true);
  begin
    insert into public.release_device_credentials
      (credential_id, binding_key, tenant_id, device_id, surface_id, token_hash,
       idempotency_hash, status, created_at, application_id, scopes, owner_id)
    values
      (next_credential_id, capability.binding_key, capability.tenant_id,
       capability.device_id, capability.surface_id, p_credential_hash,
       capability.capability_hash, 'active', p_exchanged_at,
       capability.application_id, capability.scopes, capability.owner_id);
  exception when unique_violation then
    return query select 'device_credential_conflict', null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::timestamptz;
    return;
  end;
  update public.device_enrollment_capabilities
     set consumed_at = p_exchanged_at
   where capability_id = capability.capability_id;
  return query select null::text, next_credential_id, capability.tenant_id,
    capability.owner_id, capability.device_id, capability.surface_id,
    capability.application_id, capability.scopes, p_exchanged_at;
end;
$$;

revoke all on function exchange_device_enrollment_capability(text, text, timestamptz) from public;

drop function if exists release_authenticate_device_credential(text);

create function release_authenticate_device_credential(p_token_hash text)
returns table (
  credential_id text,
  binding_key text,
  tenant_id text,
  device_id text,
  surface_id text,
  token_hash text,
  idempotency_hash text,
  status text,
  created_at timestamptz,
  application_id text,
  scopes text[],
  owner_id text
)
language sql
security definer
set search_path = pg_catalog, public
as $$
  select c.credential_id, c.binding_key, c.tenant_id, c.device_id, c.surface_id,
         c.token_hash, c.idempotency_hash, c.status, c.created_at,
         c.application_id, c.scopes, c.owner_id
    from public.release_device_credentials c
   where c.token_hash = p_token_hash and c.status = 'active'
   limit 1
$$;

revoke all on function release_authenticate_device_credential(text) from public;

commit;
