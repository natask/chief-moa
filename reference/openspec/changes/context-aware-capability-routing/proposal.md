# Context-Aware Capability Routing

## Why

Moa can answer questions about the current page and can route a small fixed set
of phone and browser actions, but it does not yet turn "what the user has open"
into a durable understanding of what work is possible. The current source-based
skill registry distinguishes Android from browser while exposing mostly fixed
capabilities. It cannot say that a GitHub page, an authenticated browser
session, a connected GitHub account, and an online browser executor are
different ways to complete the same task.

The product needs one reusable context-to-capability system across Android,
browser, macOS, Windows, and future clients. Adding a bespoke model tool for
every app or site would make auth, policy, execution, and receipts inconsistent.
Instead, Moa should resolve bounded observations against a catalog of app/site
matchers, connected accounts, and live device manifests, then offer ranked
capability references through one stable execution seam.

## What Changes

- Define a canonical, versioned observation envelope for browser pages and
  device applications. It carries identity, provenance, freshness, sensitivity,
  and project-linkage evidence without treating visible content as instruction.
- Define a declarative matcher catalog for app identifiers and web origins that
  maps observations to product/service identities and capability families.
- Define a tenant-scoped connection registry for official API integrations and
  a live device-capability registry for browser sessions and local executors.
- Add a context-aware resolver that ranks applicable execution candidates and
  explains why each is available, missing access, stale, or blocked.
- Keep the model interface stable: the model receives bounded capability
  descriptors and invokes one generic execute-capability contract by opaque
  capability and candidate IDs. Connectors do not add arbitrary code or a new
  model-visible tool schema at runtime.
- Define deterministic selection between an official API, the user's already
  authenticated browser session, and a device-local action. Browser-session
  reuse never exports cookies, passwords, or bearer tokens from the browser.
- Bind proposals, approvals, execution attempts, and receipts to the selected
  project, observation, connection/device candidate, and fresh local state.
- Define multi-device targeting so the user can ask from one surface and have
  the device that owns the needed authority execute and receipt the work.
- Establish concrete browser and Android acceptance cases before macOS and
  Windows executors are implemented.

## Capabilities

### New Capabilities

- `context-aware-capability-routing`: Resolve authenticated observations,
  project context, connected accounts, and live device manifests into bounded,
  ranked execution candidates that preserve local authority.

### Modified Capabilities

- None. Existing page Q&A, browser agent tasks, and cross-device tool requests
  remain compatible inputs and executors.

## Boundaries

- Android owns phone UI, permissions, approvals, current-state validation,
  phone-local execution, and local receipts.
- The browser extension owns browser-session state, page observation, local
  validation, browser actions, and local receipts. It never exports session
  cookies or credentials to the gateway.
- The gateway owns the observation index, service/matcher catalog, connection
  metadata, OAuth callback state, capability resolution, project linkage,
  proposal records, routing records, and durable receipt storage.
- Integration credentials remain gateway-side in an encrypted credential
  store. Android and browser clients receive only connection/capability handles.
- Server and model output is always a proposal. An observation is evidence, not
  instruction, and a match is applicability evidence, not execution authority.
- The connector interface must be provider-neutral and self-hostable. A hosted
  product such as Composio may be supported by an adapter, but is not the system
  of record or a required dependency. Better Auth or another auth framework may
  implement user/account/OAuth plumbing only if it preserves these contracts.

## Non-Goals

- No catalog covering every SaaS product in the first implementation.
- No extraction or synchronization of browser cookies, passwords, local
  storage, or bearer tokens into the gateway.
- No model-generated connector definitions, matchers, or OAuth scopes. Surface
  programs are governed separately by `define-surface-program-runtime`; they do
  not become connectors or gain connector credentials.
- No macOS or Windows app executor in this change. Their future clients consume
  the same observation, resolver, proposal, and receipt contracts.
- No autonomous send, publish, purchase, payment, account-security, or
  destructive action without the owning surface's required approval.
- No replacement of existing browser page Q&A or Android accessibility
  capture; both become producers/consumers of the shared contract.

## Verification

- OpenSpec: `openspec validate context-aware-capability-routing --strict` when
  the CLI is initialized for this checkout.
- Gateway implementation lane: deterministic resolver tests plus
  `cd gateway && npm run check`.
- Browser implementation lane: capability-resolution smoke using an
  authenticated test page plus `cd browser_extension && npm run verify && npm
  run smoke`.
- Android implementation lane: app-match and stale-package action tests plus
  `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew test
  assembleDebug`.

## Impact

- Gateway: new observation, connection, catalog, resolver, proposal, and
  execution-routing seams; adapters over existing browser-agent and device-hub
  executors.
- Browser extension: canonical page observations, local session-backed
  candidate execution, approval, revalidation, and receipts.
- Android: canonical app observations, package-bound candidate execution,
  account connection UI entry points, approval, revalidation, and receipts.
- Workflow: a small starter catalog and deterministic cross-surface acceptance
  suite become required before expanding integrations.
