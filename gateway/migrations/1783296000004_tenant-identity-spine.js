exports.up = (pgm) => {
  pgm.sql(`
    create table if not exists tenants (
      id text primary key,
      kind text not null default 'personal'
        check (kind in ('personal','organization')),
      display text not null default '',
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists tenant_memberships (
      tenant_id text not null references tenants(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      role text not null default 'owner'
        check (role in ('owner','admin','member')),
      status text not null default 'active'
        check (status in ('active','suspended','removed')),
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (tenant_id, user_id)
    );

    insert into tenants (id, kind, display)
      values ('owner','personal','Owner')
      on conflict (id) do nothing;
    insert into tenant_memberships (tenant_id, user_id, role, status)
      values ('owner','owner','owner','active')
      on conflict (tenant_id, user_id) do nothing;

    create unique index if not exists identities_auth_user_id_unique
      on identities(auth_user_id)
      where auth_user_id is not null;
    create index if not exists tenant_memberships_user_idx
      on tenant_memberships(user_id, status, tenant_id);

    grant select, insert, update, delete on tenants, tenant_memberships to moa_app;

    alter table tenants enable row level security;
    alter table tenants force row level security;
    drop policy if exists tenants_principal_isolation on tenants;
    create policy tenants_principal_isolation on tenants
      using (
        id = current_setting('moa.tenant_id', true)
        and exists (
          select 1
          from tenant_memberships membership
          where membership.tenant_id = tenants.id
            and membership.user_id = current_setting('moa.user_id', true)
            and membership.status = 'active'
        )
      )
      with check (id = current_setting('moa.tenant_id', true));

    alter table tenant_memberships enable row level security;
    alter table tenant_memberships force row level security;
    drop policy if exists tenant_memberships_principal_isolation
      on tenant_memberships;
    create policy tenant_memberships_principal_isolation on tenant_memberships
      using (
        tenant_id = current_setting('moa.tenant_id', true)
        and user_id = current_setting('moa.user_id', true)
      )
      with check (
        tenant_id = current_setting('moa.tenant_id', true)
        and user_id = current_setting('moa.user_id', true)
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop index if exists identities_auth_user_id_unique;
    drop table if exists tenant_memberships cascade;
    drop table if exists tenants cascade;
  `);
};
