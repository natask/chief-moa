begin;

-- Keep the original credential rows and revocation events immutable. This
-- additive relation gives one logical device/application binding an ordered
-- sequence of credential generations without weakening token uniqueness.
create table if not exists release_device_credential_generations (
  credential_id text primary key references release_device_credentials (credential_id),
  tenant_id text not null,
  binding_key text not null check (binding_key ~ '^[a-f0-9]{64}$'),
  generation bigint not null check (generation > 0),
  created_at timestamptz not null,
  event_order bigint generated always as identity,
  unique (tenant_id, binding_key, generation)
);

insert into release_device_credential_generations
  (credential_id, tenant_id, binding_key, generation, created_at)
select c.credential_id, c.tenant_id, c.binding_key, 1, c.created_at
  from release_device_credentials c
on conflict (credential_id) do nothing;

create index if not exists release_device_credential_generations_latest
  on release_device_credential_generations (tenant_id, binding_key, generation desc);

alter table release_device_credential_generations enable row level security;
alter table release_device_credential_generations force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
     where polname = 'release_device_credential_generations_tenant_isolation'
       and polrelid = 'release_device_credential_generations'::regclass
  ) then
    create policy release_device_credential_generations_tenant_isolation
      on release_device_credential_generations
      using (tenant_id = current_setting('moa.tenant_id', true))
      with check (tenant_id = current_setting('moa.tenant_id', true));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'release_device_credential_generations_append_only'
       and tgrelid = 'release_device_credential_generations'::regclass
       and not tgisinternal
  ) then
    create trigger release_device_credential_generations_append_only
      before update or delete or truncate on release_device_credential_generations
      for each statement execute function reject_release_control_mutation();
  end if;
end;
$$;

-- Replace the enrollment exchange at the database boundary so predecessor
-- gateway builds also gain serialized re-pair behavior after this migration.
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
  next_generation bigint;
  physical_binding_key text;
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
  perform pg_advisory_xact_lock(hashtextextended(capability.binding_key, 0));
  if exists (
    select 1
      from public.release_device_credential_generations g
      join public.release_device_credentials c on c.credential_id = g.credential_id
     where g.tenant_id = capability.tenant_id
       and g.binding_key = capability.binding_key
       and not exists (
         select 1 from public.release_device_credential_revocations r
          where r.credential_id = c.credential_id
       )
  ) then
    return query select 'device_credential_conflict', null::text, null::text,
      null::text, null::text, null::text, null::text, null::text[], null::timestamptz;
    return;
  end if;
  select coalesce(max(g.generation), 0) + 1 into next_generation
    from public.release_device_credential_generations g
   where g.tenant_id = capability.tenant_id
     and g.binding_key = capability.binding_key;
  physical_binding_key := case when exists (
    select 1 from public.release_device_credentials c
     where c.binding_key = capability.binding_key
  ) then p_credential_hash else capability.binding_key end;
  begin
    insert into public.release_device_credentials
      (credential_id, binding_key, tenant_id, device_id, surface_id, token_hash,
       idempotency_hash, status, created_at, application_id, scopes, owner_id)
    values
      (next_credential_id, physical_binding_key, capability.tenant_id,
       capability.device_id, capability.surface_id, p_credential_hash,
       capability.capability_hash, 'active', p_exchanged_at,
       capability.application_id, capability.scopes, capability.owner_id);
    insert into public.release_device_credential_generations
      (credential_id, tenant_id, binding_key, generation, created_at)
    values
      (next_credential_id, capability.tenant_id, capability.binding_key,
       next_generation, p_exchanged_at);
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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'moa_release_app') then
    grant select, insert on release_device_credential_generations to moa_release_app;
    grant usage, select on sequence release_device_credential_generations_event_order_seq
      to moa_release_app;
    grant execute on function exchange_device_enrollment_capability(text, text, timestamptz)
      to moa_release_app;
  end if;
end;
$$;

commit;
