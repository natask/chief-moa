-- The gateway store: the durable substrate under the work-graph + supervisor.
--
-- Why this exists: the model (durable nodes, disposable executors, a thin
-- supervisor that queries and launches) already lives in lib/work-graph.js and
-- server.js. What was missing under it is a real database. A single JSON file
-- flushed whole on every write cannot take concurrent writers, so the loop
-- could never fan out and merge in parallel. And there was nowhere durable to
-- put what agents PRODUCE -- plans, decisions, tool specs, results, the merged
-- answer -- so that record lived in chat sessions you have to scroll.
--
-- This schema fixes both. nodes + runs hold the work and its disposable
-- workers. events is an append-only stream workers POST concurrently with no
-- contention. artifacts is the durable, queryable record of produced work that
-- outlives any run or session. The supervisor "report" is a SELECT over these;
-- steering is INSERTs into node_corrections / node_queue the loop reads;
-- recall is a query over artifacts, not chat archaeology.
--
-- Target: self-hosted Postgres 14+ (the gateway is self-hosted). Driver: pg.
-- Apply with: psql "$DATABASE_URL" -f schema.sql  (idempotent).

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- nodes -----------------------------------------------------------------------
-- The durable forest. A node is the unit of work and lives forever. An executor
-- is a disposable worker bound to it while it does the node's current work.
-- queue / corrections / context_refs stay as jsonb on the node: they are per
-- node and low-contention, so a faithful 1:1 port of the JSON store keeps the
-- server change small. The new concurrency and recall pressure is on events and
-- artifacts, which get their own tables below.
create table if not exists nodes (
  id            text primary key,                  -- wg_<hex>, assigned by the store
  title         text not null default 'untitled',
  intent        text not null default '',          -- the original ask; corrections layer on top
  parent_id     text references nodes(id) on delete set null,
  status        text not null default 'open'
                  check (status in ('open','running','blocked','done')),
  next_step     text not null default '',          -- self-reported next move (C11)
  executor_kind text not null default 'none'
                  check (executor_kind in ('none','local','devin')),
  executor_ref  text,                              -- run id / session id, null when none
  queue         jsonb not null default '[]'::jsonb,        -- [{at,text}] FIFO (C12)
  corrections   jsonb not null default '[]'::jsonb,        -- [{at,text}] corrections win (D15)
  context_refs  jsonb not null default '[]'::jsonb,        -- context slice ids, copied on fork (B7)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists nodes_parent_idx  on nodes(parent_id);
create index if not exists nodes_status_idx  on nodes(status, created_at desc);

-- runs ------------------------------------------------------------------------
-- A disposable executor run bound to a node. The loop fires these; many can be
-- running at once across nodes (and, for speculation, on one node). Holds only
-- run-level lifecycle; the streamed detail goes to events, the kept output to
-- artifacts.
create table if not exists runs (
  id          text primary key,                    -- run id, assigned by the store
  node_id     text not null references nodes(id) on delete cascade,
  kind        text not null default 'local',       -- echo | local | cdp | devin | ...
  status      text not null default 'running'
                check (status in ('running','done','error','cancelled')),
  instruction text not null default '',            -- effective instruction at launch
  result      text,                                -- short completion summary
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists runs_node_idx   on runs(node_id, started_at desc);
create index if not exists runs_status_idx on runs(status);

-- events ----------------------------------------------------------------------
-- The append-only stream. Workers POST here as they go; this is the only table
-- under real concurrent write pressure, and append-only with a per-node
-- sequence is exactly what takes it without contention. The reducer reads a
-- node's events and writes a merged artifact. Never updated, only inserted.
create table if not exists events (
  id      bigint generated always as identity primary key,
  node_id text not null references nodes(id) on delete cascade,
  run_id  text references runs(id) on delete set null,
  seq     bigint not null,                         -- per-node monotonic order
  type    text not null
            check (type in ('partial','final','tool_call','tool_result','status','error')),
  payload jsonb not null default '{}'::jsonb,
  ts      timestamptz not null default now(),
  unique (node_id, seq)
);
create index if not exists events_node_seq_idx on events(node_id, seq);
create index if not exists events_run_idx      on events(run_id);

-- artifacts -------------------------------------------------------------------
-- The durable record of produced work: the thing that was missing. A plan, a
-- decision, a tool spec, a run result, or the merged answer the reducer writes
-- from a node's events. Outlives every run and session. Recall is a query here
-- (kind + full text over body), so you never scroll chats to find a decision.
create table if not exists artifacts (
  id         uuid primary key default gen_random_uuid(),
  node_id    text references nodes(id) on delete cascade,
  run_id     text references runs(id) on delete set null,
  kind       text not null
               check (kind in ('plan','decision','tool_spec','result','merged_answer','note')),
  title      text not null default '',
  body       text not null default '',             -- markdown / text the agent produced
  refs       jsonb not null default '{}'::jsonb,   -- structured side data, links to other ids
  created_at timestamptz not null default now(),
  search     tsvector generated always as
               (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))) stored
);
create index if not exists artifacts_node_idx   on artifacts(node_id, created_at desc);
create index if not exists artifacts_kind_idx   on artifacts(kind, created_at desc);
create index if not exists artifacts_search_idx on artifacts using gin(search);

-- account connections ----------------------------------------------------------
-- User-connected provider accounts and their credential health. Contract:
-- reference/openspec/changes/remote-hosted-gateway/account-connection-policy.md.
-- The local JSON projection in lib/account-connections.js implements this model
-- today; hosted/self-host modes move behind these tables with the same store
-- interface. Raw credentials live ONLY in account_connection_credentials as
-- AES-256-GCM ciphertext or an opaque broker handle; API serializers never
-- select from that table.

create table if not exists account_connections (
  id                         text primary key,             -- acctconn_<hex>
  user_id                    text not null,                -- better-auth user id (single-user token hash until then)
  provider                   text not null,                -- stable catalog id, e.g. 'openai'
  label                      text not null default '',
  account_subject            jsonb not null default '{}'::jsonb,  -- {display, provider_account_id, subscription_id, organization_id}
  credential_kind            text not null
                               check (credential_kind in ('oauth2_authorization_code','oauth2_device_code','api_key','personal_access_token','service_account','external_handle','none')),
  status                     text not null default 'pending_user_auth'
                               check (status in ('pending_user_auth','connected','refreshing','action_required','expired','invalid','disabled','revoked','error')),
  status_reason              text not null default '',
  expires_at                 timestamptz,
  scopes_granted             jsonb not null default '[]'::jsonb,
  refresh                    jsonb not null default '{}'::jsonb,  -- {supported,state,last_attempt_at,last_success_at,next_attempt_at,failure_code,failure_message,attempt_count}
  needs_user_action          boolean not null default false,
  user_action                jsonb,                               -- non-secret {reason,message,since,reauth_endpoint,action_type,expires_at}
  device_notification_target jsonb,                               -- {device_id,surface_type,channel,enabled}
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  status_changed_at          timestamptz not null default now(),
  last_health_check_at       timestamptz,
  last_used_at               timestamptz
);
create index if not exists account_connections_user_idx
  on account_connections(user_id, provider, created_at desc);
-- Multiple connections per provider are allowed; duplicate provider subjects
-- are not when the provider gives a stable account id.
create unique index if not exists account_connections_subject_uniq
  on account_connections(user_id, provider, (account_subject->>'provider_account_id'), coalesce(account_subject->>'subscription_id',''))
  where (account_subject->>'provider_account_id') is not null
    and (account_subject->>'provider_account_id') <> ''
    and status not in ('revoked','disabled');

-- The credential boundary. Never joined into list/detail serializers.
create table if not exists account_connection_credentials (
  connection_id       text primary key references account_connections(id) on delete cascade,
  credential_ref_kind text not null default 'encrypted_server_secret'
                        check (credential_ref_kind in ('encrypted_server_secret','opaque_broker_handle','provider_managed_session','none')),
  enc_iv              text,          -- base64, aes-256-gcm
  enc_tag             text,
  enc_data            text,
  broker_handle       text,          -- opaque handle when a broker owns the secret
  retired             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Optimized audit projection; canonical stream id is
-- 'account-connection:{connection_id}'. Payloads are non-secret by contract.
create table if not exists account_connection_events (
  id            bigint generated always as identity primary key,
  connection_id text not null references account_connections(id) on delete cascade,
  type          text not null,
  actor         jsonb not null default '{}'::jsonb,
  payload       jsonb not null default '{}'::jsonb,
  ts            timestamptz not null default now()
);
create index if not exists account_connection_events_conn_idx
  on account_connection_events(connection_id, ts desc);
