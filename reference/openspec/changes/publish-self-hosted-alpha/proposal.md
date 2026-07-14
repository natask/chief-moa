# Publish The Self-Hosted Alpha

## Status

Proposed for user alignment. This change does not make the repository public,
publish a package, tag a release, or deploy a new service.

## Intent

Chief Moa should stop waiting for product completeness before people can use
it. Publish the current system as an honest, self-hostable alpha that technical
builders can inspect, run, and improve.

The first public release succeeds when a new builder can:

1. understand what Chief Moa is and is not;
2. deploy the gateway with their own infrastructure and provider credentials;
3. connect at least one packaged client;
4. complete one text turn using a deterministic or user-configured provider;
5. find known limitations, security guidance, and contribution boundaries;
6. remove the installation without leaving an undocumented active service.

## Intent Order

1. **Primary:** make the source legally and operationally publishable.
2. **Primary:** prove a clean-machine self-host journey for one supported path.
3. **Constraint:** describe the product as alpha software and do not imply that
   unfinished auth, multi-user hosting, voice reliability, or local action
   execution is production-ready.
4. **Follow-up:** package Android and browser clients so people can try the
   cross-surface experience without building every component from source.
5. **Later:** offer a hosted demo or managed service after tenant isolation,
   account auth, abuse controls, budgets, and recovery are proven.

## Release Options

### Option A: Publish the repository immediately as source-available

Make the current repository visible and let early users infer setup from the
existing docs.

- Advantage: fastest possible visibility.
- Cost: without a root license it is not meaningfully open source; personal
  configuration examples, a broad feature surface, and incomplete onboarding
  create avoidable trust and support failures.
- Decision: reject.

### Option B: Publish a bounded self-hosted alpha

Add the legal, security, onboarding, packaging, and verification evidence for
one golden path, then make the repository public and create a versioned alpha
release.

- Advantage: people can use the real product now without pretending the whole
  roadmap is complete.
- Cost: the first audience is technical builders; some features remain
  experimental or build-from-source.
- Decision: recommended.

### Option C: Wait for a hosted consumer beta

Finish account auth, tenant isolation, billing, polished onboarding, and managed
operations before publishing.

- Advantage: a simpler experience for non-technical users.
- Cost: repeats the current delay, hides useful work, and makes public feedback
  arrive after more architecture has hardened.
- Decision: reject for the first release; retain as a later product lane.

## Proposed Release Contract

### Audience

The alpha is for builders comfortable with Docker, DNS/TLS, provider keys, and
installing an unpacked or prerelease client. It is not yet a general consumer
assistant or a shared multi-user service.

### Supported Golden Path

```text
public repository or signed source archive
  -> Docker Compose gateway + Postgres on a user-owned machine/VPS
  -> user-owned HTTPS URL and gateway token
  -> browser extension release artifact (first required client)
  -> deterministic loopback smoke
  -> optional user-owned model provider
  -> one authenticated text turn
```

The browser extension is the required first client because it has a packaging
and smoke path that does not require Android signing or phone installation.
Android can ship in the same alpha only if its APK provenance, signer
continuity, install instructions, rollback, and phone smoke are proven.

Voice, workers, phone actions, companion creation, and hosted convenience remain
available only where their existing checks pass. They are not release blockers
for the basic text-turn golden path and must be labeled experimental.

### Ownership And Trust

- The gateway continues to own provider credentials, routing, durable state,
  and worker coordination.
- Clients store only a gateway URL and gateway/device token. No provider secret
  is packaged in a client or release artifact.
- Model output remains a proposal. Browser and Android retain local execution
  and approval authority.
- The public repository contains no active deployment credentials, private
  infrastructure assumptions, personal provider project identifiers, retained
  user data, recordings, or generated private artifacts.
- A self-hoster supplies and owns their infrastructure, provider accounts,
  backups, and upgrades.

### Canonical Release State

Git tags and GitHub release metadata are the canonical public release record.
Each release names the exact commit, supported surfaces, artifacts and hashes,
known limitations, migration compatibility, rollback instructions, and smoke
evidence. A successful build is not described as a published release, and a
published artifact is not described as an installed or smoke-tested client.

### Failure Behavior

- Remote mode fails closed without a token or Postgres.
- Missing provider credentials fall back only to the documented deterministic
  experience; they do not silently charge or use maintainer credentials.
- Failed onboarding identifies URL, auth, provider, database, or client-version
  failure separately.
- The uninstall/rollback path leaves user-owned data intact unless the user
  explicitly removes volumes.

## Public Release Gates

All gates apply to the exact commit that will be made public and tagged.

1. **Legal:** select a root license and confirm every bundled asset and
   dependency can be distributed under it. A component-only license is not
   sufficient.
2. **Secret and privacy audit:** scan the full Git history and release tree;
   rotate anything exposed; exclude `.env`, credentials, recordings, database
   dumps, retained user data, signing material, and private artifacts.
3. **Documentation hygiene:** replace maintainer-specific IPs, local paths,
   provider project ids, and active-operator instructions in public onboarding
   with safe placeholders or clearly separated maintainer docs.
4. **Golden-path onboarding:** a clean machine follows one short quickstart from
   clone to a protected text turn without private knowledge.
5. **Exact-stack verification:** Compose config and isolated startup pass;
   health, auth rejection, Postgres persistence, deterministic turn, backup,
   restore check, and teardown are recorded.
6. **Client artifact:** package and smoke the browser extension from the same
   commit; publish its version, hash, install, update, and rollback steps.
7. **Community safety:** publish `SECURITY.md`, support boundaries, issue/PR
   templates, a code of conduct, and an explicit alpha limitations page.
8. **Release integrity:** create a prerelease tag and changelog/release notes,
   attach artifacts and checksums, then verify all public links from a logged-out
   browser.

## Current Readiness Finding (2026-07-14)

Already present:

- architecture and contributor boundaries;
- gateway Dockerfile and Compose/Postgres stack;
- self-host and VPS runbooks;
- remote-mode fail-fast auth/database requirements;
- browser verification, smoke, package, and release workflow;
- active hosted landing page and production gateway operations path.

Visible blockers or incomplete evidence:

- no root project license was found;
- no root `SECURITY.md` or code of conduct was found;
- the GitHub CLI is unavailable locally, and an unauthenticated request to the
  configured repository URL returned 404, so repository visibility could not be
  independently distinguished from a private repository;
- the root/gateway docs still include maintainer-specific private-network IPs,
  a Google Cloud project id, local paths, and active deployment language;
- the self-host OpenSpec still marks the isolated Compose smoke incomplete;
- better-auth and per-device registration remain incomplete, so the alpha must
  use the documented single-owner gateway-token boundary;
- the current worktree contains unrelated in-progress voice/source changes and
  is not an eligible release tree;
- full-history secret/privacy scanning and third-party asset/license review have
  not yet been evidenced.

## Rollout

1. Prepare the release in an isolated clean branch/worktree from the intended
   public base commit.
2. Close legal, privacy, documentation, and clean-machine gates without changing
   the active service.
3. Build and smoke an isolated preview Compose stack with separate state.
4. Build the browser artifact and generate checksums from the release commit.
5. Review the public tree as an unauthenticated outsider.
6. Make the repository public only after the user explicitly approves the
   selected license and final public-tree audit.
7. Create `v0.1.0-alpha.1` as a prerelease and publish the artifacts.
8. Run the quickstart from the public URLs, record issues, and keep the existing
   active gateway unchanged unless a separate promotion gate passes.

## User Decisions Required For Alignment

1. Approve the bounded self-hosted alpha shape (Option B).
2. Select the root license. Apache-2.0 is recommended for an application with
   external contributors because it includes an explicit patent grant; MIT is
   the simpler permissive alternative.
3. Confirm that the browser extension is the required first client and Android
   is included only if its release evidence is ready.
4. Confirm the proposed first tag: `v0.1.0-alpha.1`.

## Impact

This change is primarily release engineering and documentation. It does not
move Android, browser, gateway, or worker authority. Any runtime defect found by
the golden-path test becomes a separate narrow ticket with one observable
acceptance check.
