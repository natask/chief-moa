exports.up = (pgm) => {
  pgm.sql(`
    create table if not exists billing_price_versions (
      user_id text not null references users(id) on delete restrict,
      price_id text not null,
      version text not null,
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      unit_minor bigint not null check (unit_minor between 0 and 9007199254740991),
      unit_size bigint not null check (unit_size between 1 and 9007199254740991),
      effective_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      primary key (user_id, price_id, version)
    );

    create table if not exists billing_usage_facts (
      usage_id text not null,
      user_id text not null references users(id) on delete restrict,
      meter text not null,
      source_event_id text not null,
      quantity bigint not null check (quantity between 0 and 9007199254740991),
      price_id text not null,
      price_version text not null,
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      amount_minor bigint not null check (amount_minor between 0 and 9007199254740991),
      occurred_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      primary key (user_id, usage_id),
      unique (user_id, meter, source_event_id),
      foreign key (user_id, price_id, price_version)
        references billing_price_versions(user_id, price_id, version) on delete restrict
    );

    create table if not exists billing_entitlement_facts (
      user_id text not null references users(id) on delete restrict,
      entitlement_id text not null,
      version text not null,
      state text not null check (state in ('active','limited','past_due','grace','suspended',
        'disputed','refunded','review_required','disabled')),
      effective_at timestamptz not null,
      reason text not null default '',
      policy_ref text not null default '',
      recorded_at timestamptz not null default now(),
      primary key (user_id, entitlement_id, version)
    );

    create table if not exists billing_budget_versions (
      user_id text not null references users(id) on delete restrict,
      budget_id text not null,
      version text not null,
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      limit_minor bigint not null check (limit_minor between 0 and 9007199254740991),
      effective_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      primary key (user_id, budget_id, version)
    );

    create table if not exists billing_budget_reservations (
      user_id text not null references users(id) on delete restrict,
      reservation_id text not null,
      budget_id text not null,
      budget_version text not null,
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      amount_minor bigint not null check (amount_minor between 0 and 9007199254740991),
      limit_minor bigint not null check (limit_minor between 0 and 9007199254740991),
      recorded_at timestamptz not null default now(),
      primary key (user_id, budget_id, reservation_id),
      foreign key (user_id, budget_id, budget_version)
        references billing_budget_versions(user_id, budget_id, version) on delete restrict
    );

    create table if not exists billing_webhook_receipts (
      user_id text not null references users(id) on delete restrict,
      receipt_id text not null,
      provider text not null,
      provider_event_id text not null,
      event_type text not null,
      payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
      signed_at timestamptz not null,
      status text not null check (status in ('verified_unapplied','applied','rejected','review_required')),
      recorded_at timestamptz not null default now(),
      primary key (user_id, receipt_id),
      unique (user_id, provider, provider_event_id)
    );

    create table if not exists billing_adjustment_facts (
      user_id text not null references users(id) on delete restrict,
      adjustment_id text not null,
      kind text not null check (kind in ('refund','dispute','correction')),
      currency text not null check (currency ~ '^[A-Z]{3}$'),
      amount_minor bigint not null check (amount_minor between -9007199254740991 and 9007199254740991),
      source_receipt_id text not null,
      occurred_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      primary key (user_id, adjustment_id)
    );

    create index if not exists billing_usage_user_meter_occurred_idx
      on billing_usage_facts(user_id, meter, occurred_at);
    create index if not exists billing_entitlement_user_effective_idx
      on billing_entitlement_facts(user_id, entitlement_id, effective_at desc);
    create index if not exists billing_budget_user_budget_idx
      on billing_budget_reservations(user_id, budget_id, recorded_at);
    create index if not exists billing_webhook_user_recorded_idx
      on billing_webhook_receipts(user_id, recorded_at);
    create index if not exists billing_adjustment_user_recorded_idx
      on billing_adjustment_facts(user_id, recorded_at);

    grant select, insert on billing_price_versions, billing_usage_facts,
      billing_entitlement_facts, billing_budget_versions, billing_budget_reservations,
      billing_webhook_receipts, billing_adjustment_facts to moa_app;

    alter table billing_price_versions enable row level security;
    alter table billing_price_versions force row level security;
    create policy billing_price_versions_user_isolation on billing_price_versions
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
    alter table billing_usage_facts enable row level security;
    alter table billing_usage_facts force row level security;
    create policy billing_usage_facts_user_isolation on billing_usage_facts
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
    alter table billing_entitlement_facts enable row level security;
    alter table billing_entitlement_facts force row level security;
    create policy billing_entitlement_facts_user_isolation on billing_entitlement_facts
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
    alter table billing_budget_versions enable row level security;
    alter table billing_budget_versions force row level security;
    create policy billing_budget_versions_user_isolation on billing_budget_versions
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
    alter table billing_budget_reservations enable row level security;
    alter table billing_budget_reservations force row level security;
    create policy billing_budget_reservations_user_isolation on billing_budget_reservations
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
    alter table billing_webhook_receipts enable row level security;
    alter table billing_webhook_receipts force row level security;
    create policy billing_webhook_receipts_user_isolation on billing_webhook_receipts
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));
    alter table billing_adjustment_facts enable row level security;
    alter table billing_adjustment_facts force row level security;
    create policy billing_adjustment_facts_user_isolation on billing_adjustment_facts
      using (user_id = current_setting('moa.user_id', true))
      with check (user_id = current_setting('moa.user_id', true));

    -- Immutable facts: application role intentionally receives no UPDATE or DELETE.
    revoke update, delete on billing_price_versions, billing_usage_facts,
      billing_entitlement_facts, billing_budget_versions, billing_budget_reservations,
      billing_webhook_receipts, billing_adjustment_facts from moa_app;
  `);
};

// Billing history is deliberately not dropped by an automated rollback. A
// staged restore/migration contract is required before destructive removal.
exports.down = () => {};
