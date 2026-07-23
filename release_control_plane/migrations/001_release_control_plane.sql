begin;

create table if not exists release_bundles (
  bundle_id text not null,
  tenant_id text not null,
  application_id text not null,
  created_at timestamptz not null,
  record jsonb not null,
  event_order bigint generated always as identity,
  primary key (tenant_id, application_id, bundle_id),
  check (record->>'bundle_id' = bundle_id),
  check (record->>'tenant_id' = tenant_id),
  check (record->>'application_id' = application_id)
);

create table if not exists release_channel_head_events (
  tenant_id text not null,
  application_id text not null,
  channel text not null,
  sequence bigint not null check (sequence > 0),
  created_at timestamptz not null,
  record jsonb not null,
  event_order bigint generated always as identity,
  primary key (tenant_id, application_id, channel, sequence),
  check (record->>'tenant_id' = tenant_id),
  check (record->>'application_id' = application_id),
  check (record->>'channel' = channel),
  check ((record->>'sequence')::bigint = sequence)
);

create table if not exists release_assignment_events (
  event_id text not null,
  tenant_id text not null,
  application_id text not null,
  scope_type text not null,
  scope_id text not null,
  sequence bigint not null check (sequence > 0),
  idempotency_key text,
  created_at timestamptz not null,
  record jsonb not null,
  event_order bigint generated always as identity,
  primary key (tenant_id, application_id, event_id),
  unique (tenant_id, application_id, scope_type, scope_id, sequence),
  check (record->>'event_id' = event_id),
  check (record->>'tenant_id' = tenant_id),
  check (record->>'application_id' = application_id),
  check (record->>'scope_type' = scope_type),
  check (record->>'scope_id' = scope_id),
  check ((record->>'sequence')::bigint = sequence)
);

create table if not exists release_install_receipts (
  receipt_id text not null,
  tenant_id text not null,
  application_id text not null,
  device_id text not null,
  idempotency_key text not null,
  created_at timestamptz not null,
  record jsonb not null,
  event_order bigint generated always as identity,
  primary key (tenant_id, application_id, receipt_id),
  check (record->>'receipt_id' = receipt_id),
  check (record->>'tenant_id' = tenant_id),
  check (record->>'application_id' = application_id)
);

create table if not exists release_feedback (
  feedback_id text not null,
  tenant_id text not null,
  application_id text not null,
  device_id text not null,
  idempotency_key text not null,
  created_at timestamptz not null,
  record jsonb not null,
  event_order bigint generated always as identity,
  primary key (tenant_id, application_id, feedback_id),
  check (record->>'feedback_id' = feedback_id),
  check (record->>'tenant_id' = tenant_id),
  check (record->>'application_id' = application_id)
);

create index if not exists release_bundles_tenant_app
  on release_bundles (tenant_id, application_id, created_at);
create index if not exists release_heads_tenant_app
  on release_channel_head_events (tenant_id, application_id, channel, sequence desc);
create index if not exists release_assignments_tenant_app_scope
  on release_assignment_events (tenant_id, application_id, scope_type, scope_id, sequence desc);
create unique index if not exists release_assignments_idempotency
  on release_assignment_events (tenant_id, application_id, scope_type, scope_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists release_receipts_tenant_app
  on release_install_receipts (tenant_id, application_id, created_at);
create index if not exists release_feedback_tenant_app
  on release_feedback (tenant_id, application_id, created_at);
create unique index if not exists release_receipts_idempotency
  on release_install_receipts (tenant_id, application_id, device_id, idempotency_key);
create unique index if not exists release_feedback_idempotency
  on release_feedback (tenant_id, application_id, device_id, idempotency_key);

alter table release_bundles enable row level security;
alter table release_bundles force row level security;
alter table release_channel_head_events enable row level security;
alter table release_channel_head_events force row level security;
alter table release_assignment_events enable row level security;
alter table release_assignment_events force row level security;
alter table release_install_receipts enable row level security;
alter table release_install_receipts force row level security;
alter table release_feedback enable row level security;
alter table release_feedback force row level security;

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'release_bundles',
    'release_channel_head_events',
    'release_assignment_events',
    'release_install_receipts',
    'release_feedback'
  ]
  loop
    policy_name := table_name || '_tenant_isolation';
    if not exists (
      select 1 from pg_policy
       where polname = policy_name
         and polrelid = table_name::regclass
    ) then
      execute format(
        'create policy %I on %I using '
        '(tenant_id = current_setting(''moa.tenant_id'', true)) with check '
        '(tenant_id = current_setting(''moa.tenant_id'', true))',
        policy_name,
        table_name
      );
    end if;
  end loop;
end;
$$;

create or replace function reject_release_control_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'release control-plane records are append-only';
end;
$$;

do $$
declare
  table_name text;
  trigger_name text;
begin
  foreach table_name in array array[
    'release_bundles',
    'release_channel_head_events',
    'release_assignment_events',
    'release_install_receipts',
    'release_feedback'
  ]
  loop
    trigger_name := table_name || '_append_only';
    if not exists (
      select 1 from pg_trigger
       where tgname = trigger_name
         and tgrelid = table_name::regclass
         and not tgisinternal
    ) then
      execute format(
        'create trigger %I before update or delete or truncate on %I '
        'for each statement execute function reject_release_control_mutation()',
        trigger_name,
        table_name
      );
    end if;
  end loop;
end;
$$;

-- The application role receives INSERT/SELECT grants outside this migration.
-- The triggers fail closed if broader table privileges are granted by mistake.

commit;
