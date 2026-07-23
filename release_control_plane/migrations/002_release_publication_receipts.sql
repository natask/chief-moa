begin;

create table if not exists release_publication_receipts (
  receipt_id text not null,
  tenant_id text not null,
  application_id text not null,
  channel text not null check (channel in ('preview', 'stable')),
  sequence bigint not null check (sequence > 0),
  created_at timestamptz not null,
  record jsonb not null,
  event_order bigint generated always as identity,
  primary key (tenant_id, application_id, receipt_id),
  unique (tenant_id, application_id, channel, sequence),
  check (record->>'receipt_id' = receipt_id),
  check (record->>'tenant_id' = tenant_id),
  check (record->>'application_id' = application_id),
  check (record->>'channel' = channel),
  check ((record->>'new_sequence')::bigint = sequence)
);

create index if not exists release_publication_receipts_tenant_app
  on release_publication_receipts (tenant_id, application_id, channel, sequence desc);

alter table release_publication_receipts enable row level security;
alter table release_publication_receipts force row level security;

do $$
begin
  if not exists (
    select 1
      from pg_policy
     where polname = 'release_publication_receipts_tenant_isolation'
       and polrelid = 'release_publication_receipts'::regclass
  ) then
    create policy release_publication_receipts_tenant_isolation
      on release_publication_receipts
      using (tenant_id = current_setting('moa.tenant_id', true))
      with check (tenant_id = current_setting('moa.tenant_id', true));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgname = 'release_publication_receipts_append_only'
       and tgrelid = 'release_publication_receipts'::regclass
       and not tgisinternal
  ) then
    create trigger release_publication_receipts_append_only
      before update or delete or truncate on release_publication_receipts
      for each statement execute function reject_release_control_mutation();
  end if;
end;
$$;

-- The application role receives INSERT/SELECT grants outside this migration.

commit;
