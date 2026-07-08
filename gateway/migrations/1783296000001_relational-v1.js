exports.up = (pgm) => {
  pgm.sql(`
    create table if not exists users (
      id text primary key,
      kind text not null default 'owner'
        check (kind in ('owner','anonymous','account')),
      is_anonymous boolean not null default false,
      display text not null default '',
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists identities (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      auth_user_id text,
      provider text not null default 'gateway-token',
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists devices (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      surface text not null default '',
      label text not null default '',
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists sessions (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      kind text not null default 'default',
      label text not null default '',
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists branches (
      session_id text not null references sessions(id) on delete cascade,
      branch_id text not null,
      user_id text not null references users(id) on delete cascade,
      kind text not null default 'default',
      parent_branch_id text,
      fork_point text,
      label text not null default '',
      summary text not null default '',
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (session_id, branch_id)
    );

    create table if not exists turns (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      session_id text,
      branch_id text,
      turn_id text,
      device_id text,
      source text,
      model text,
      profile_version text,
      data jsonb not null default '{}'::jsonb,
      occurred_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists voice_turns (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      session_id text,
      conversation_id text,
      branch_id text,
      turn_id text,
      profile_version text,
      classification text,
      source text,
      transcript text,
      blob_ref text,
      blob_sha256 text,
      data jsonb not null default '{}'::jsonb,
      occurred_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists agent_runs (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      status text not null default 'pending',
      harness text,
      session_id text,
      branch_id text,
      prompt text,
      result text,
      error text,
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz
    );

    create table if not exists browser_tasks (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      status text,
      instruction text,
      url text,
      source text,
      conversation_id text,
      branch_id text,
      profile_version text,
      agent_run_id text,
      claimed_by text,
      claimed_at timestamptz,
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists tool_requests (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      status text,
      target_device_id text,
      surface text,
      tool text,
      source text,
      claimed_at timestamptz,
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists agent_profiles (
      user_id text not null references users(id) on delete cascade,
      scope text not null default 'global',
      current_version text,
      data jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      primary key (user_id, scope)
    );

    create table if not exists agent_profile_versions (
      user_id text not null references users(id) on delete cascade,
      scope text not null default 'global',
      version text not null,
      sequence bigint,
      source text,
      reason text,
      parent_version text,
      rollback_from_version text,
      changed jsonb not null default '[]'::jsonb,
      data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      primary key (user_id, scope, version)
    );

    insert into users (id, kind, is_anonymous, display)
      values ('owner','owner',false,'Owner')
      on conflict (id) do nothing;
    insert into identities (id, user_id, provider)
      values ('owner','owner','gateway-token')
      on conflict (id) do nothing;

    create index if not exists users_policy_id_idx on users(id);
    create index if not exists identities_user_id_idx on identities(user_id);
    create index if not exists devices_user_id_idx on devices(user_id);
    create index if not exists sessions_user_id_idx on sessions(user_id);
    create index if not exists branches_user_id_idx on branches(user_id);
    create index if not exists turns_user_id_idx on turns(user_id);
    create index if not exists voice_turns_user_id_idx on voice_turns(user_id);
    create index if not exists agent_runs_user_id_idx on agent_runs(user_id);
    create index if not exists browser_tasks_user_id_idx on browser_tasks(user_id);
    create index if not exists tool_requests_user_id_idx on tool_requests(user_id);
    create index if not exists agent_profiles_user_id_idx on agent_profiles(user_id);
    create index if not exists agent_profile_versions_user_id_idx
      on agent_profile_versions(user_id);

    create index if not exists sessions_user_updated_idx
      on sessions(user_id, updated_at desc);
    create index if not exists turns_user_session_occurred_idx
      on turns(user_id, session_id, occurred_at);
    create index if not exists voice_turns_user_session_occurred_idx
      on voice_turns(user_id, session_id, occurred_at);
    create index if not exists agent_runs_user_status_created_idx
      on agent_runs(user_id, status, created_at desc);
    create index if not exists browser_tasks_user_status_idx
      on browser_tasks(user_id, status);
    create index if not exists tool_requests_user_status_idx
      on tool_requests(user_id, status);

    -- Roles are cluster-global, so a check-then-create races when two
    -- migrations run concurrently against different databases in one cluster
    -- (and would also fail for a self-hoster whose cluster already has the
    -- role). Create-and-swallow-duplicate is atomic and idempotent.
    -- duplicate_object: role already existed before this tx.
    -- unique_violation: another tx inserted the shared role row concurrently.
    do $$ begin
      create role moa_app nologin;
    exception when duplicate_object or unique_violation then null;
    end $$;

    grant usage on schema public to moa_app;
    grant select, insert, update, delete on all tables in schema public to moa_app;
    grant usage, select on all sequences in schema public to moa_app;
    alter default privileges in schema public
      grant select, insert, update, delete on tables to moa_app;
    alter default privileges in schema public
      grant usage, select on sequences to moa_app;

    alter table users enable row level security;
    alter table users force row level security;
    drop policy if exists users_user_isolation on users;
    create policy users_user_isolation on users
      using (id = current_setting('moa.user_id', true))
      with check (id = current_setting('moa.user_id', true));

    alter table identities enable row level security;
    alter table identities force row level security;
    drop policy if exists identities_user_isolation on identities;
    create policy identities_user_isolation on identities
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table devices enable row level security;
    alter table devices force row level security;
    drop policy if exists devices_user_isolation on devices;
    create policy devices_user_isolation on devices
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table sessions enable row level security;
    alter table sessions force row level security;
    drop policy if exists sessions_user_isolation on sessions;
    create policy sessions_user_isolation on sessions
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table branches enable row level security;
    alter table branches force row level security;
    drop policy if exists branches_user_isolation on branches;
    create policy branches_user_isolation on branches
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table turns enable row level security;
    alter table turns force row level security;
    drop policy if exists turns_user_isolation on turns;
    create policy turns_user_isolation on turns
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table voice_turns enable row level security;
    alter table voice_turns force row level security;
    drop policy if exists voice_turns_user_isolation on voice_turns;
    create policy voice_turns_user_isolation on voice_turns
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table agent_runs enable row level security;
    alter table agent_runs force row level security;
    drop policy if exists agent_runs_user_isolation on agent_runs;
    create policy agent_runs_user_isolation on agent_runs
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table browser_tasks enable row level security;
    alter table browser_tasks force row level security;
    drop policy if exists browser_tasks_user_isolation on browser_tasks;
    create policy browser_tasks_user_isolation on browser_tasks
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table tool_requests enable row level security;
    alter table tool_requests force row level security;
    drop policy if exists tool_requests_user_isolation on tool_requests;
    create policy tool_requests_user_isolation on tool_requests
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table agent_profiles enable row level security;
    alter table agent_profiles force row level security;
    drop policy if exists agent_profiles_user_isolation on agent_profiles;
    create policy agent_profiles_user_isolation on agent_profiles
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    alter table agent_profile_versions enable row level security;
    alter table agent_profile_versions force row level security;
    drop policy if exists agent_profile_versions_user_isolation
      on agent_profile_versions;
    create policy agent_profile_versions_user_isolation on agent_profile_versions
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists agent_profile_versions cascade;
    drop table if exists agent_profiles cascade;
    drop table if exists tool_requests cascade;
    drop table if exists browser_tasks cascade;
    drop table if exists agent_runs cascade;
    drop table if exists voice_turns cascade;
    drop table if exists turns cascade;
    drop table if exists branches cascade;
    drop table if exists sessions cascade;
    drop table if exists devices cascade;
    drop table if exists identities cascade;
    drop table if exists users cascade;

    do $$ begin
      if exists (select 1 from pg_roles where rolname = 'moa_app') then
        revoke all privileges on schema public from moa_app;
        revoke all privileges on all tables in schema public from moa_app;
        revoke all privileges on all sequences in schema public from moa_app;
        alter default privileges in schema public
          revoke select, insert, update, delete on tables from moa_app;
        alter default privileges in schema public
          revoke usage, select on sequences from moa_app;
        drop role moa_app;
      end if;
    end $$;
  `);
};
