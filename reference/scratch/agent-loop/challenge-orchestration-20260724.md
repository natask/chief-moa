# Chief Moa challenge orchestration

Date: 2026-07-24

Source: the user's attached product-direction note and the follow-up request to
launch parallel agents, verify what is feasible, and define the work sequence.

This file is the shared plan. It does not grant a worker permission to deploy,
spend money on live provider tests, expose credentials, or change an active
user session.

## Completion target

Finish the personal product first:

1. Show a bare moving lion on Android.
2. Keep the remove target and transcript usable on the physical phone.
3. Measure the current voice path and fix the slowest measured stage.
4. Pass one phone and browser voice acceptance run.
5. Publish exact preview artifacts and promote them only when the normal safety
   gate passes.

Treat hosted multi-user auth, credential delegation, billing, and Voice CMDK as
separate programs. They must not block the personal-product cutoff.

## Audit lanes

Seven read-only agents ran in parallel.

| Lane | Result |
| --- | --- |
| Android overlay | The fixed transcript, bubbles, anchored drag, and remove action exist. The bare animated lion and speech correction flow do not. Physical-phone inset and scroll QA remain open. |
| Voice pipeline | Streaming Chirp STT, streaming reasoning, chunked ordered TTS, diagnosis records, and provider seams exist. Current timing clocks cannot prove the main bottleneck. |
| Credential broker | Moa can broker requests and capabilities. It must never vend raw vendor credentials. Subscription-backed CLIs belong on isolated workers under their official login rules. |
| Hosted auth | Better Auth fits Google login and sessions. The live gateway still uses one owner token and cannot safely host mutually untrusted users. |
| Companion and command UI | The browser has a bare animated lion. The website pet studio has motion, voice selection, replay, and re-voice. Android still shows a static lion inside a disc. |
| Verification and release | Deterministic checks exist for every surface. Production gateway and Android are behind the repository. The VPS promoter still has an unresolved rollout gap. |
| Workflow inventory | The requests map to three programs: personal-product closure, hosted-product identity and metering, and companion or Voice CMDK work. |

Focused checks run during the audit:

- Credential, connector, worker, remote-mode, and launcher tests: 73 passed.
- Hosted auth, device credential, remote-mode, and billing tests: 30 passed.
- Companion package tests: 47 passed.
- Browser verification: 133 passed.
- Focused voice tests and deterministic smokes passed. The fake cascaded turn
  completed in 928 ms with three ordered TTS chunks.

These checks prove code paths. They do not replace a real phone, browser mic, or
live provider run.

## Current truth

### Android overlay

- `OrbView` draws a static lion image over an opaque circular disc.
- The only continuous animation pulses the rim. Motion values draw accents
  around the lion. They do not animate the lion.
- The browser already has a transparent 256 px lion asset at
  `browser_extension/extension/moa-mark.png`. The first Android slice can reuse
  it for in-place motion. Bounded walking may need a sprite asset lane.
- The transcript has a fixed scroll viewport and distinct user and assistant
  bubbles.
- Each partial transcript rebuilds the rows and forces the scroll view to the
  bottom. A user cannot read older text while speech continues.
- The remove target uses raw display height. It does not use system insets.
- The app stores an orb scale setting, but the overlay does not apply it.
- Typed input gets normal Android keyboard suggestions. Spoken terms have no
  alternatives, confidence, correction UI, or personal phrase flow.

### Voice

- Production reports Chirp 3 STT, gateway reasoning on Vertex, and Gemini TTS.
- Android streams 40 ms PCM frames. The browser streams through an
  AudioWorklet.
- The gateway streams STT partials, streams LLM text, chunks sentences and
  clauses, runs up to two TTS calls at once, and emits audio in order.
- The voice task ledgers lag the source. Reconcile claims before assigning new
  implementation work.
- `first_audio_ms` uses different clock origins in different paths.
- `tts_ms` overlaps reasoning. Stage values cannot be added.
- The system lacks a full commit-to-playout timeline from client to gateway and
  back.
- Production health reports stored provider drift and conflicting capability
  projections.
- The voice model test plan still names the decommissioned machine and the old
  provider baseline.

### Credential and harness broker

- The gateway already owns sessions, text and audio routing, provider calls,
  account connections, worker claims, and agent runs.
- LiteLLM can sit behind the OpenAI-compatible provider seam. It does not
  replace Moa voice or harness orchestration.
- Clients should receive Moa device tokens and short-lived invocation grants.
- API credentials should resolve inside provider adapters.
- Codex, Claude Code, and Gemini CLI subscription login must stay inside the
  official client on an isolated worker. Auth files and vendor tokens must not
  cross the worker boundary.
- Current shared execution defaults are too broad for a hosted credential
  machine. Credential-bearing workers need separate OS profiles and narrower
  harness policy.

### Hosted product

- Better Auth is chosen in the existing hosted-product OpenSpec, but the
  package and runtime are not installed.
- The current bearer token is the effective user identity. Token rotation can
  therefore change ownership.
- Relational tables and RLS scaffolding exist, but the live gateway often uses
  a database owner and still reads many file stores.
- The billing domain has append-only sandbox facts and tests. Model calls do
  not yet reserve budgets or meter real usage through that domain.
- Google login is missing from the current task list, which names email and
  passkey.
- The product needs a stable internal principal and tenant ID. Product data
  must not use the Better Auth user ID as its permanent foreign key.
- The website source is sparse-excluded from this checkout. A web login lane
  must use the real Pages project or first record a new surface decision.

### Companion and command UI

- The browser has the strongest current lion surface. It has idle and state
  animation, drag, resize, and profile-driven companion replacement.
- The website pet studio already supports Shimeji-style movement, voice
  selection, stored replies, replay, and re-voice.
- Android receives palette and motion metadata but discards sprite and persona
  fields.
- Signed companion packages have a strict parser. Public trust roots,
  moderation, revocation freshness, and device-approved apply are not wired
  end to end.
- Command autocomplete and speech correction are different features. Command
  autocomplete can match known commands and entities. Speech correction must
  preserve the literal transcript and add an explicit corrected value.

### Release state

- The main checkout was clean at the latest review on
  `feat/device-preview-delivery-20260723` at `0ad9ffa9`.
- `origin/master` is now `0ad9ffa9`. The branch is no longer ahead of master.
- `origin/vps-deploy` is `ab7cf7bc`, two commits behind master.
- Public gateway health reported `c0572df2`, behind both master and
  `origin/vps-deploy`. The public promoter has not consumed the older deploy
  ref.
- The active Android OTA is `0.1.1784199280` from `60a8e593`, far behind the
  repository.
- Earlier Android overlay and release-control branches are already ancestors of
  master. Do not merge them again.
- Several old worktrees are dirty or conflicted. Build new work in clean,
  isolated worktrees from current master.

## Orchestration graph

```text
audit and current-truth join
├── personal product
│   ├── product choices
│   ├── parallel isolated visual, geometry, transcript, and voice timing work
│   ├── serial Android integration
│   ├── parallel deterministic checks
│   ├── persistent previews and real phone/browser QA
│   └── release join and promotion
├── hosted product
│   ├── identity and tenant contract
│   ├── parallel auth, schema, vault, metering, worker, and voice-grant work
│   ├── serial principal-to-receipt integration
│   ├── parallel clients and provider adapters
│   ├── two-tenant security and restore proof
│   └── staged rollout
└── companion and Voice CMDK
    ├── product decision
    ├── parallel command catalog, UI, and asset work
    ├── package authority integration
    └── cross-surface parity
```

## Program A: personal-product closure

### Gate A0: settle four product choices

Run this gate in series.

1. Use the bare lion as the default Android anchor. Keep an invisible stable
   touch target for current gestures.
2. Compare an in-place animated lion with bounded screen traversal. Select the
   first slice after a phone-sized prototype. Record movement bounds, pause
   rules, reduced motion, and battery limits.
3. Let the transcript move independently from the lion. Keep both inside safe
   bounds and prevent the transcript from covering the lion or remove target.
4. Define spoken autocomplete as explicit transcript correction. Keep the
   literal transcript immutable.

Acceptance: update the Android overlay OpenSpec with these choices and preserve
the Android trust boundary.

### Gate A0.5: reconcile voice claims

Run this gate before assigning new voice work.

- Map each unchecked streaming voice task to source, test, release, and live QA
  evidence.
- Mark each task as verified, implemented but unverified, specified, or missing.
- Update the stale voice model test plan.

Acceptance: no new voice ticket relies on a stale checkbox or decommissioned
machine.

### Wave A1: parallel implementation

#### A1 Android lion

Files:

- `android_app/app/src/main/java/ai/moa/assistant/OrbView.java`
- `android_app/app/src/main/java/ai/moa/assistant/MainActivity.java`
- `android_app/app/src/main/java/ai/moa/assistant/MoaPrefs.java`
- Android drawable assets

Work:

- Reuse the transparent browser lion.
- Remove all visible disc pixels.
- Add the selected low-cost idle, listening, thinking, speaking, and error
  motion.
- Stop the idle animator when detached or when reduced motion is enabled.
- Apply the saved size setting.
- Keep the current gesture target and results.
- Rename visible "orb" copy to "lion" or "assistant".

Acceptance: render tests and `assembleDebug` show no disc or square backing.
Focused gesture tests still pass. Reserve phone video for Wave A4.

#### A2 Inset-safe remove target

Files:

- `MoaOrbRemoveTarget.java`
- `MoaOrbOverlayGeometry.java`
- focused geometry tests

Work:

- Pass measured safe display bounds into layout and hit testing.
- Measure the label instead of assuming the raw display bottom is safe.
- Keep the final-release drop rule.

Acceptance: geometry tests keep the full measured target inside supplied safe
bounds for portrait, landscape, default text, and large text. Reserve phone
screenshots for Wave A4.

#### A3 Transcript scroll policy

Files:

- a new pure scroll-follow policy and tests
- `OverlayService.java` during the later integration step

Work:

- Follow new partial text only when the user is near the bottom.
- Preserve manual scroll position while speech continues.
- Show a small Latest action when new text arrives off screen.

Acceptance: ten partial updates do not move a user who scrolled upward. A user
at the bottom still follows the newest text.

#### A3b Independently movable transcript bubble

Files:

- overlay geometry and drag policy
- `OverlayService.java` during the later integration step

Work:

- Make header drag move only the transcript card.
- Leave the lion position and gestures unchanged.
- Keep the card within safe bounds.
- Keep the height cap and prevent overlap with the lion and remove target.

Acceptance: geometry and drag tests prove independent movement and no overlap.
Reserve scrolling and drag phone video for Wave A4.

#### A4 Voice timing contract

Files:

- gateway voice event and diagnosis modules
- Android and browser endpoint receipt code
- health projection tests

Work:

- Define one commit-relative milestone schema.
- Record capture, transport, final STT, LLM first token, TTS first byte, socket
  first audio, and client playout.
- Fix health capability and provider-drift projections.

Acceptance: one deterministic turn reports non-overlapping milestones with
documented clocks.

#### A6 Transcript correction contract

Work:

- Preserve the immutable literal transcript.
- Store an explicit corrected revision, selected span, provenance, and optional
  personal phrase.
- Bound alternatives and confidence.
- Route the corrected value only after user approval.

Acceptance: correct one deliberately missed proper noun. The retained literal
transcript remains byte-for-byte unchanged. A repeated approval stays
idempotent.

### Wave A2: serial integration

Integrate in this order because each Android lane meets in `OverlayService`:

1. Lion view and size handling.
2. Safe bounds and remove target.
3. Transcript scroll policy and independent card drag.
4. Gateway-backed correction UI after A6.

Run the focused tests after each step. Keep commits small and conventional.

### Wave A3: parallel verification

- Android: `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew check assembleDebug`
- Gateway: `cd gateway && npm run check && npm run smoke:cascaded-voice && npm run smoke:streaming-stt && npm run smoke:voice-diagnosis`
- Browser: `cd browser_extension && npm run verify && npm run smoke`
- Release control: `cd release_control_plane && npm run check`
- OpenSpec: `openspec validate <changed-change-id> --strict` for each changed
  change
- Release plan: `bash scripts/deploy.sh plan <exact-candidate-evidence.json>`

### Gate A3.5: freeze the candidate

After all fixes:

1. Commit the integrated unit.
2. Rerun every affected deterministic check.
3. Record the exact git SHA, surface version, artifact SHA-256, signer for
   Android, and rollback target.
4. Build previews from those exact bytes.

A rebuild creates a new candidate. Do not reuse QA evidence from earlier bytes.

### Wave A4: live acceptance

Create persistent previews for one exact commit.

- Run one device-reachable gateway preview with its own URL, database, file and
  blob prefix, queue, worker identity and pool, credentials, callbacks, cleanup
  owner, expiry, and revoke path. A loopback process or CI artifact is not a
  preview.
- Build Android into a unique `android_app/deploy/preview/<candidate>`
  directory with the continuity signer. Verify signer, size, and SHA against
  the manifest. Serve it through the authenticated preview server without
  moving the stable OTA head.
- If browser source changed, choose a unique version and package it. Load it in
  an isolated browser and confirm the exact manifest version and digest after
  the user-approved reload. If browser source did not change, do not create a
  package only to fill the bundle.
- Measure live voice on the same corpus and name the dominant stage.
- Run phone QA for insets, scrolling, text selection, remove behavior, lion
  motion, battery, and frame pacing.
- Run browser mic and first-playout QA.
- Record Android and browser publication, install, activation, and smoke
  separately against the exact digest.

Run provider A/B trials in series against the same preview. They use money and
must have explicit approval. Phone and browser endpoint QA can run in parallel
after the preview is stable.

### Gate A4.5: repair the measured bottleneck

Run this gate after the first live baseline.

```text
live baseline
  -> identify dominant stage
  -> repair one stage
  -> repeat the identical corpus
  -> accept only if latency improves without transcript or long-audio regression
```

If no stage exceeds the agreed budget, record that result and make no latency
change.

### Wave A5: release join

Require exact digests, preview smoke, rollback, N/N-1 compatibility,
no-interruption evidence, backup, scratch restore, and the A4.5 retest. Back up
and restore every persisted store the candidate touches. This includes gateway
Postgres, file and blob references, and the separate release-control database
when enabled. Restore the exact pre-promotion state in scratch.

The current first-rollout blocker comes first. Install and prove the two
separate release-control database role credentials with the documented
idempotent installer. Do not restart the live gateway for this step. The
candidate promoter must recheck them before preview and backup. Repair and prove
the timer worker because public health still shows that it has not consumed the
older deploy ref.

Move master only through `scripts/release/push-master.sh`. Immediately before
the first active effect, recheck recordings, voice turns, uploads, queues, agent
runs, and sessions. Require `drain_safe=true` or a proved resume path. Recheck
the promotion lease and control-plane authority after backup and restore.

When the candidate changes the gateway contract or clients depend on it, wait
for the public gateway to report the exact commit before publishing clients.
For a client-only change, prove compatibility with the currently live gateway.

Report `built`, `packaged`, `published`, `installed`, `activated`, and `smoked`
as separate states bound to the exact digest.

Surface gates:

- Gateway: CI advances `vps-deploy`. The promoter runs isolated preview,
  backup, scratch restore, compatibility, drain recheck, apply, and public
  exact-SHA smoke. A failure restores the old ref, artifact, and state.
- Android: retain the prior continuity-signed artifact and know the reinstall
  or downgrade recovery path. Do not publish or install during an active phone
  voice session. Keep the system installer user-approved.
- Browser: choose a collision-free version with
  `scripts/release/next-extension-version.sh`. Reload only when browser work is
  safe. Report success only after the loaded extension acknowledges the new
  version.

## Program B: hosted product

### Gate B0: identity and tenant contract

Run this gate in series before hosted code.

Decide and record:

- Google-first login and optional anonymous use
- stable internal principal and personal tenant IDs
- Better Auth identity mapping and account-link behavior
- owner-token migration
- device enrollment, rotation, and revocation
- deletion, export, and retention
- self-host auth modes
- model-call billing unit

Acceptance: one threat model and one additive identity migration map cover HTTP,
voice WebSocket, workers, files, blobs, billing, and account connections.

### Wave B1: parallel foundations

After B0, run these lanes in parallel:

- Better Auth spike with Google login, secure cookies, trusted origins, and
  principal mapping
- tenant schema and non-owner database role
- Postgres envelope vault with rotation and revoke
- model-call reservation, immutable pricing, usage, and budget design
- isolated worker OS profile and harness policy
- voice invocation-grant binding
- hosted, self-host, and local auth configuration
- web account shell in the real website project

Each lane must have one narrow acceptance check. No lane may infer tenant
authority from a caller-supplied user ID.

### Gate B2: serial integration

Integrate:

```text
authenticated subject
  -> stable principal and tenant
  -> short-lived audience-bound invocation grant
  -> provider adapter or isolated worker
  -> usage reservation
  -> result and receipt
  -> exact usage reconciliation
```

Apply additive schema and backup proof before switching live reads. Keep the
legacy bearer mapped to the stable owner during the transition.

### Wave B3: parallel adapters and clients

After B2:

- product device enrollment and revoke UI
- Android and browser login
- LiteLLM or direct API adapter
- isolated Codex worker
- isolated Claude worker
- isolated Gemini worker
- voice stage metering
- account and usage UI
- subscription or CLI reasoning spike
- public multimodal client conformance

The subscription or CLI spike sends one bounded reasoning request through a
locally authenticated Codex, Claude, or Gemini worker. It records latency,
concurrency, and provider-policy limits. No provider credential crosses the
worker boundary.

The public client conformance check gives a fresh device one grant and completes
text, audio, async run, cancellation, and receipt flows through versioned
schemas.

Subscription workers use official local CLI login only. One user's subscription
must never serve another user.

### Gate B4: hosted security

Require:

- two-user IDOR tests across HTTP, voice, worker claims, blobs, profiles,
  account connections, billing, and admin paths
- non-owner database access with transaction-local tenant context
- immediate device and invocation-grant revocation
- secret redaction
- vault rotation and recovery
- migration count and hash checks
- backup and scratch restore
- N/N-1 compatibility

Only then enable a small external cohort.

### Gate B5: billing

Wire Stripe after model-call metering is exact.

Keep webhook input as signed evidence. Apply it through an idempotent
reconciler. Never let a webhook body change an entitlement directly.

## Program C: companion and Voice CMDK

This program does not block Program A.

### Gate C0: product choice

Choose whether Voice CMDK is:

- Chief Moa positioning
- a reusable package
- a separate product

Define a typed `command_item` contract with ID, label, aliases, argument schema,
availability, authority owner, and result kind.

### Wave C1: parallel first slices

- Browser searchable command list with keyboard and screen-reader behavior
- gateway read-only command catalog
- 2D lion frame asset and license lane
- website frame preview and package export
- Android stored reply replay and re-voice design

Command selection creates a typed proposal. It does not execute an arbitrary
string.

### Gate C2: package authority

Replace direct catalog mutation with:

```text
verified package
  -> preview receipt
  -> device-signed approval
  -> apply receipt
  -> rollback receipt
```

Add public publisher identity, trust roots, licenses, moderation, and revocation
only after this path works.

## Worker packet contract

Each future agent receives:

- required repo docs
- one OpenSpec change
- exact source files
- one observable acceptance check
- one verification command
- one isolated branch or worktree
- explicit no-deploy and no-secret rules unless its lane owns those actions

Agents that edit the same file run in series. Android integration agents that
touch `OverlayService.java` run in series. Gateway auth and storage agents may
work in parallel only against agreed interfaces and additive migrations.
Provider experiments run in series against one stable preview. Surface checks
run in parallel against the same exact candidate.

## Next executable wave

Start Program A.

1. Update the Android overlay spec for the bare lion, independently movable
   transcript, and explicit correction contract.
2. Complete Gate A0.5.
3. Launch A1, A2, A3, A3b, A4, and A6 in isolated worktrees.
4. Join the Android changes in the listed order.
5. Run deterministic checks.
6. Create one exact persistent preview and complete real phone and browser QA.
7. Repair and retest the measured bottleneck before the release join.

Do not start hosted billing or an auth replacement during this wave.
