begin;

-- Revocation is an additive event rather than an update to the immutable
-- credential record. Old code continues to see the original active row while
-- new authentication checks fail closed whenever this event exists.
create table if not exists release_device_credential_revocations (
  credential_id text primary key references release_device_credentials (credential_id),
  tenant_id text not null,
  reason text not null check (reason in (
    'owner_requested', 'device_lost', 'credential_rotated', 'security_response'
  )),
  revoked_at timestamptz not null,
  event_order bigint generated always as identity
);

create index if not exists release_device_credential_revocations_tenant_time
  on release_device_credential_revocations (tenant_id, revoked_at desc);

alter table release_device_credential_revocations enable row level security;
alter table release_device_credential_revocations force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
     where polname = 'release_device_credential_revocations_tenant_isolation'
       and polrelid = 'release_device_credential_revocations'::regclass
  ) then
    create policy release_device_credential_revocations_tenant_isolation
      on release_device_credential_revocations
      using (tenant_id = current_setting('moa.tenant_id', true))
      with check (tenant_id = current_setting('moa.tenant_id', true));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'release_device_credential_revocations_append_only'
       and tgrelid = 'release_device_credential_revocations'::regclass
       and not tgisinternal
  ) then
    create trigger release_device_credential_revocations_append_only
      before update or delete or truncate on release_device_credential_revocations
      for each statement execute function reject_release_control_mutation();
  end if;
end;
$$;

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
   where c.token_hash = p_token_hash
     and c.status = 'active'
     and not exists (
       select 1 from public.release_device_credential_revocations r
        where r.credential_id = c.credential_id
     )
   limit 1
$$;

revoke all on function release_authenticate_device_credential(text) from public;

-- These grants are conditional so the migration also remains usable in schema
-- validation databases that do not create the production application role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'moa_release_app') then
    grant select, insert on release_device_credential_revocations to moa_release_app;
    grant usage, select on sequence release_device_credential_revocations_event_order_seq
      to moa_release_app;
    grant execute on function release_authenticate_device_credential(text)
      to moa_release_app;
  end if;
end;
$$;

commit;
