# Context-Aware Capability Routing Tasks

Each implementation unit has one observable acceptance check. Browser,
Android, gateway, workflow/docs, and verification/deploy are separate lanes.

## 0. Cross-Surface Execution V1 (delivery bridge; implement before catalog)

- [ ] 0.1 Freeze and validate the six convenience schemas:
      `browser_open_tab`, `browser_close_tab`, `browser_background_task`,
      `android_open_app`, `android_open_url`, and `android_semantic_action`.
  - Acceptance: golden invalid-input cases reject oversized values, unknown
    action enums, and stale target references without enqueueing a proposal;
    code and IR use the separate surface-program envelope rather than hiding in
    convenience-tool fields.
- [ ] 0.1a Implement the `define-surface-program-runtime` envelope and profile
      registry: browser JS/TS plus granted CDP domains; Android versioned IR.
  - Acceptance: allowed programs execute only inside the bound surface scope,
    denied grants fail before effect, and cancel/expiry converge on one terminal
    receipt.
- [ ] 0.2 Route each accepted call to a typed device-hub proposal and preserve
      proposal/approval/idempotency/receipt bindings needed by the later generic
      catalog seam.
  - Acceptance: a deterministic cross-device smoke proves one browser and one
    Android proposal can be claimed only by the bound fresh device and that a
    second claim returns the same result without a duplicate effect.
- [ ] 0.3 Implement task-owned browser background tabs with inactive creation,
      opaque handles, renewable leases, restart reconciliation, and idempotent
      cleanup on finish/failure/cancel/expiry.
  - Acceptance: fixture QA proves the tab never becomes active; only the
    task-created tab is modified/closed; a forged handle and a user-created tab
    return `not_owned`/`ownership_lost` and remain open.
- [ ] 0.4 Implement Android package/window-bound semantic accessibility
      actions using short-lived observation target references and the local
      accessibility action allowlist.
  - Acceptance: phone QA performs one allowed semantic action; package change,
    window change, expired observation, missing target, password target, and
    unsupported action each produce the expected receipt with no effect.
- [ ] 0.5 Add the V1 evaluation matrix and exact-artifact evidence capture.
  - Acceptance: the report records contract tests, gateway smoke, browser
    fixture smoke, Android build/tests, exact extension version/package digest,
    exact APK digest/signer, reload/install confirmation, and post-activation
    smoke as distinct fields.
- Verification: `cd gateway && npm run check`; `cd browser_extension && npm run
  verify && npm run smoke`; `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew test assembleDebug`; then the new browser/background-tab and real
  phone semantic-action smoke commands added by the implementation lanes.
- Delivery: commit each lane separately. Package and attempt safe promotion only
  after its verification gate. Report `packaged`, `published_not_installed`,
  `reload_unverified`, `installed_not_smoked`, or `active_smoke_passed`
  truthfully; never collapse them into "deployed."

## 1. Shared Contract And Deterministic Resolver (gateway lane)

- [ ] 1.1 Add bounded schemas and validators for `observation.v1`, catalog
      services/matchers/capabilities, executor candidates, resolution results,
      proposals, and receipts.
  - Acceptance: malformed/oversized observations, credential-shaped fields,
    expired execution observations, and model-authored matchers fail closed.
- [ ] 1.2 Implement exact application-ID and normalized origin/path matchers,
      including adversarial subdomain fixtures.
  - Acceptance: `*.example.com` never matches `example.com.attacker.test`, and
    titles/text alone never establish a service match.
- [ ] 1.3 Implement deterministic candidate resolution and reason codes over a
      keyless fixture catalog, connections, projects, and device manifests.
  - Acceptance: a golden table proves explicit target, match strength,
    project/account binding, readiness, least privilege, executor policy,
    freshness, and stable-ID tie-breaking in order.
- [ ] 1.4 After V1 is green, expose one bounded resolve endpoint and migrate the
      V1 surface tools behind one generic `execute_capability` seam without
      registering per-service model tools.
  - Acceptance: adding a fixture catalog service changes resolution data but
    does not change the model tool schema.
- Verification: deterministic resolver smoke plus `cd gateway && npm run check`.

## 2. Connection And Connector Foundation (gateway/auth lane)

- [x] 2.1 Define the self-hostable connector adapter interface: authorize,
      callback, refresh, revoke, health, list capabilities, execute, and receipt.
  - Acceptance: a deterministic no-network adapter completes the full lifecycle
    and never exposes its credential reference to a client/model response.
- [ ] 2.2 Add tenant/user-scoped connection metadata and gateway-owned encrypted
      credential references with documented backup/restore requirements.
  - Acceptance: cross-tenant/account lookup fails and connection list responses
    contain labels/scopes/health but no credential material.
- [ ] 2.3 Implement OAuth state + PKCE callback binding, least-privilege scope
      display, refresh rotation, revoke, and reconnect states against the
      deterministic adapter before selecting a live provider.
  - Acceptance: replayed/wrong-user/wrong-tenant callbacks and scope escalation
    fail closed.
- [x] 2.4 Evaluate Better Auth and one open connector framework against this
      contract; record adopt/adapter/reject decisions in this change before live
      integration work.
  - Acceptance: the decision names portability, self-hosting, credential
    custody, provider coverage, migration, and backup/restore consequences.
- Verification: connection/auth smoke plus `cd gateway && npm run check`.

## 3. Project Linkage And Policy (gateway/workflow lane)

- [ ] 3.1 Resolve explicit active-thread project, one-turn override, and
      user-authored origin/repository/document rules with inspectable basis and
      confidence.
  - Acceptance: visible page content cannot relink a project; explicit choice
    wins and incognito creates no durable rule.
- [ ] 3.2 Bind resolution, proposal, approval, and receipt records to project ID
      and enforce confirmation below the side-effect confidence threshold.
  - Acceptance: a cross-project replay or mutated project binding fails closed.
- Verification: deterministic project-linkage smoke plus gateway check.

## 4. Browser Observation And Session Executor (browser lane)

- [ ] 4.1 Adapt existing page evidence to `observation.v1` with origin, URL,
      digest, capture grant, redaction metadata, and project hints.
  - Acceptance: current-page Q&A remains green and the canonical observation
    omits cookies, authorization headers, passwords, and browser storage.
- [ ] 4.2 Advertise fresh browser-session candidates from the existing extension
      manifest/heartbeat without representing the login as an API connection.
  - Acceptance: a logged-in fixture page with no API connection resolves the
    browser candidate `ready` and the API candidate `needs_connection`.
- [ ] 4.3 Adapt existing local browser actions/agent loop to claim a bound
      proposal, revalidate origin + observation digest, request approval, and
      return a receipt.
  - Acceptance: the unsaved-draft fixture ranks browser first, updates the draft
    only, and requires a separate explicit-confirm proposal to publish.
- [ ] 4.4 Prove the dual-candidate case with a deterministic API fixture and
      authenticated browser fixture.
  - Acceptance: issue creation ranks the scoped API first and returns a durable
    issue ID; browser cookie material is absent from all captured gateway
    requests and records.
- Verification: `cd browser_extension && npm run verify && npm run smoke && npm
  run smoke:unified-browser-agent` plus the new resolver/session smoke.
- Release: bump the extension manifest patch version, package, and reload only
  after the active-promotion safety gate passes; otherwise record the artifact
  path and blocker.

## 5. Android Observation And Local Executor (Android lane)

- [ ] 5.1 Adapt accessibility window/package snapshots to `observation.v1`,
      defaulting raw tree/text to local-only evidence.
  - Acceptance: a matched foreground app resolves by exact package and the
    uploaded observation contains no raw screen text unless an explicit bounded
    context grant exists.
- [ ] 5.2 Advertise Android local candidates through the existing device
      manifest and add account-connection entry points that open gateway-owned
      authorization UI rather than handling provider credentials in-app.
  - Acceptance: Android stores only gateway/session handles and displays
    connection health/scopes returned by the gateway.
- [ ] 5.3 Bind screen-dependent proposals to expected package, observation ID,
      digest, target device, and expiry; revalidate immediately before action.
  - Acceptance: changing the foreground package before execution yields a
    `stale_state` receipt and no tap/navigation action.
- [ ] 5.4 Verify a safe matched-app operation end to end.
  - Acceptance: an explicit open-URL request selects the current Android device,
    executes through local policy, and receipts before/after package identity
    without raw accessibility text.
- Verification: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk"
  ./gradlew test assembleDebug` plus phone QA.
- Release: publish an OTA artifact only after verification and the
  no-interruption/rollback gate; otherwise record the blocker.

## 6. Multi-Device Routing (gateway + owning-client lanes)

- [ ] 6.1 Rank fresh device candidates using explicit target, observation owner,
      project affinity, last-used preference, and stable tie-breaking.
  - Acceptance: an explicit compatible target wins; stale/incompatible devices
    report reason-coded unavailability.
- [ ] 6.2 Bind claim/receipt to the selected device and make retries idempotent.
  - Acceptance: another device cannot claim or receipt the proposal.
- [ ] 6.3 Prove Android-origin to browser-execution flow and offline behavior.
  - Acceptance: the selected browser receipts the request; if it goes offline, a
    side effect stays queued/blocked and is not silently retargeted.
- Verification: gateway device-hub smoke plus browser and Android narrow checks.

## 7. Workflow, Documentation, And Expansion Gate (workflow/docs lane)

- [ ] 7.1 Update `ARCHITECTURE.md` with the observation, catalog, connection,
      resolver, project, generic execution, and receipt boundaries when the
      first implementation unit lands.
- [ ] 7.2 Add a starter catalog contribution template requiring match fixtures,
      least-privilege scopes, schemas, risk/approval class, executor support,
      and expected receipts.
- [ ] 7.3 Record the first live service selection and auth-framework decision;
      do not expand the catalog until browser and Android fixture cases pass.
- [ ] 7.4 Create later implementation changes for macOS and Windows that consume
      this same contract; do not fork the core resolver per platform.
- Verification: `openspec validate context-aware-capability-routing --strict`.

## 8. Finish, Preview, And Promotion (verification/deploy lane, serial last)

- [ ] 8.1 Run every touched surface's narrow verification and the complete
      cross-surface acceptance suite.
- [ ] 8.2 Commit completed units independently with Conventional Commits.
- [ ] 8.3 Create isolated preview state, connection fixtures, queues, and worker
      pools; prove no production credential or browser session is used.
- [ ] 8.4 Prove rollback, persisted-state compatibility, no interrupted active
      work, and backup/restore for connection/proposal/receipt records.
- [ ] 8.5 Run `bash scripts/deploy.sh auto` only when the active-promotion gate
      passes, then smoke the promoted targets; otherwise record the exact
      blocker and release artifacts.
