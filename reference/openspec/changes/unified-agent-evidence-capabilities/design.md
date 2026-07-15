# Unified Agent Evidence Capabilities Design

## Diagnosis And Design Principle

The current paths capture useful inputs but do not assemble them uniformly.
Search is absent from some provider/route combinations. Browser pixels are
captured, uploaded, and then stripped before inference. Broker packs may contain
opaque evidence IDs rather than resolved evidence. Video is processed only
after a separate capture-first workflow. CDP can evaluate JavaScript, but the
reasoning model has no typed program authority contract.

The design separates four decisions:

1. Which answer capabilities are available to this reasoning route?
2. Which bounded evidence may the provider process for this turn?
3. Which additional evidence may the model propose that the user capture?
4. Which local authority profile, grants, and receipts permit a browser effect?

## 1. Ordinary Reasoning Turn

Every ordinary answer-producing route assembles `moa.reasoning-turn.v2`:

```json
{
  "schema": "moa.reasoning-turn.v2",
  "turn": {
    "turn_id": "turn-...",
    "session_id": "session-...",
    "branch": "default",
    "source": "browser|android|broker|voice",
    "role": "explain|help|collaborate|delegate",
    "query": "Explain what changed on this page"
  },
  "observation_refs": ["obs-..."],
  "evidence_refs": ["evidence-..."],
  "capability_snapshot_id": "caps-...",
  "retention_policy_id": "retention-..."
}
```

The gateway authenticates the actor, validates all references and bounds, then
resolves provider-native input immediately before inference. A capability
snapshot is inspectable and stable for the attempt. Resuming after new evidence
retains the turn identity, original query, role, branch, delegation envelope,
and ordinary capability policy unless a recorded policy/freshness change makes
one unavailable.

Forced schema/control calls are not ordinary reasoning turns. Context preflight,
transcription, TTS, and the privacy-first proactive endpoint keep their existing
minimal capability contracts.

## 2. Evidence Asset

`evidence_asset.v1` separates evidence bytes from observations and intent:

```json
{
  "schema": "evidence_asset.v1",
  "evidence_id": "evidence-...",
  "kind": "screenshot|video|page_text|accessibility_summary",
  "subject": "browser_tab|application|window|screen",
  "captured_at": "RFC3339",
  "expires_at": "RFC3339",
  "media": {
    "transport": "inline|gateway_blob",
    "media_type": "image/jpeg",
    "byte_count": 1234,
    "sha256": "sha256:..."
  },
  "grant": {
    "class": "explicit_turn|user_started_capture|timed_context_grant",
    "surface_id": "surface-...",
    "user_initiated": true
  },
  "model_use": "optional",
  "retention": "request_only|short_lived|user_kept"
}
```

The validator applies kind-specific media type, byte, dimension/duration,
freshness, digest, actor/surface, and capture-grant limits. `model_use: optional`
means the answer may use or ignore the evidence semantically. It does not mean
the provider can avoid processing pixels already included in its request; the
UI and receipt must state when bytes were sent to a provider.

An observation identifies the page/application and its freshness, provenance,
redactions, and semantic summary. It does not embed unbounded page bodies or
grant capture/execution authority. Broker evidence references must resolve to
authorized observations/assets before model or harness invocation; unresolved,
expired, or unauthorized references are omitted with a reason rather than
treated as useful context.

## 3. Route-Uniform Search

The gateway builds the same answer-capability catalog for Android chat, browser
turns/evidence, browser HTTP voice, cascaded voice, broker direct-answer and
research, and screenshot/video continuations:

```json
{
  "web_search": {
    "mode": "native|gateway_function|unavailable",
    "provider": "vertex|openai_compatible|none",
    "reason": "native_supported|bounded_search_configured|no_supported_backend"
  }
}
```

- Prefer provider-native web search.
- Otherwise offer the same bounded gateway search function through the route's
  ordinary tool loop when configured.
- Otherwise omit the tool and disclose that search is unavailable. Prompt text
  must not claim a tool exists.
- The model decides whether the question needs current external information.
  Search remains read-only retrieval, needs no action approval, grants no
  browser-session authority, and cannot become arbitrary program network access.
- Store bounded invocation metadata and normalized source URLs used in the
  answer, not unrestricted raw result bodies. Search credentials remain gateway
  side.

## 4. Initial Browser Multimodal Evidence

For an explicitly submitted current-page question, the browser collects the
already-authorized bounded semantic observation and optional visible-tab JPEG
before the first request. The initial `moa.reasoning-turn.v2` carries both. The
gateway validates the image and maps the asset to provider-native multimodal
input. A provider without image support receives deterministic text-only
degradation recorded on the turn. Capture failure or an oversized/stale image
does not fail an otherwise valid text turn.

The image is `request_only` by default. Turn history may retain its digest,
dimensions, byte count, capture/grant metadata, and provider-processing receipt,
but not its raw bytes. A user may explicitly choose a different supported
retention policy. No second `needs_evidence` round trip is required when the
initial evidence is sufficient; a compatibility endpoint may remain for older
clients and genuine later evidence.

Android accessibility summaries may use the shared evidence envelope now.
Android pixels remain unavailable until a separate, visible, platform-granted
capture path is implemented and verified.

## 5. Model-Requested, User-Started Video

When motion or change over time is materially necessary, the model may propose:

```json
{
  "schema": "moa.video-evidence-request.v1",
  "request_id": "video-request-...",
  "turn_id": "turn-...",
  "query_revision": 1,
  "reason": "Motion over time is needed to answer the question",
  "capture_scope": "tab|window|screen",
  "max_duration_seconds": 120,
  "needs_audio": true,
  "status": "proposed"
}
```

This record has zero capture authority. The owning extension shows a trusted
Start recording control. Only a user activation may open Chrome's picker,
obtain screen/microphone access, start recording, or upload bytes. The packaged
surface owns the recording indicator, stop, duration/size caps, cancellation,
and deletion.

After stop, the surface uploads an actual `evidence_asset.v1` video and
idempotently attaches it to the originating turn. The gateway resumes the same
query, session, branch, role, delegation envelope, and capability catalog. It
records proposal, user-started, captured, uploaded, attached, provider-processed,
failed, expired, and deleted states. It never turns the recording into an
unrelated generic voice turn.

If the provider supports video, it receives the actual video. An unsupported
provider returns `video_provider_unsupported` and may offer a separately
approved provider switch. Frame sampling or transcription is a separately
disclosed derivation, never a silent claim that the provider received video.

## 6. Browser Program And Authority Profiles

Generated page evaluation uses `moa.browser-program.v2`:

```json
{
  "schema": "moa.browser-program.v2",
  "artifact_id": "script-...",
  "revision": 3,
  "source_turn_id": "turn-...",
  "name": "Label the chart",
  "purpose": "Draw grounded explanatory labels",
  "source": "/* complete inspectable source */",
  "source_sha256": "sha256:...",
  "mode": "immediate|persistent",
  "world": "USER_SCRIPT|MAIN",
  "target": {
    "tab_id": 42,
    "document_id": "document-...",
    "frame_scope": "top",
    "origins": ["https://example.test"],
    "matches": [],
    "excludes": []
  },
  "authority": {
    "profile": "reviewed_standalone_v1",
    "standalone": {
      "approval_id": "approval-...",
      "approved_source_sha256": "sha256:...",
      "approved_scope_digest": "sha256:..."
    }
  },
  "bridge_capabilities": [],
  "limits": {"timeout_ms": 5000, "max_result_bytes": 16384},
  "rollback": {"prior_revision": 2, "cleanup_entrypoint": "optional"}
}
```

The authority object is profile-discriminated, not a bag of optional Delegate
fields. A delegated program replaces `standalone` with:

```json
{
  "profile": "delegated_runtime_v1",
  "delegated": {
    "role": "delegate",
    "task_id": "task-...",
    "run_id": "run-...",
    "delegation_envelope_id": "envelope-...",
    "grant_ids": ["grant-script-evaluate", "grant-origin"],
    "checkpoint_approval_id": null
  }
}
```

`source_turn_id` and creator/provenance metadata belong to the common artifact
envelope, not the authority discriminator. `reviewed_standalone_v1` requires the
standalone approval plus approved source and scope digests and SHALL NOT invent
a Delegate role, task, run, envelope, or grant. `delegated_runtime_v1` requires
the typed Delegate role, task, run, envelope, and exact grants; a checkpoint
approval is present only when the envelope reaches an approval checkpoint.
Validators reject mixed, missing, or unknown authority variants.

The source digest, exact target, world, profile-discriminated authority,
permission state, applicable grant/checkpoint state, and resource limits are
revalidated locally immediately before every execution/registration.

### `reviewed_standalone_v1`

This is the safe default and preserves the older Tier C contract:

- a distinct default-off Tier C switch and Chrome userScripts enablement;
- complete source/hash/scope inspection and direct approval for every changed
  revision;
- exact host permission, top-frame `USER_SCRIPT`, registration read-back, and
  verified removal;
- no `MAIN` execution and no CDP fallback.

### `delegated_runtime_v1`

This is the separately opted-in private runtime for a confirmed Delegate task:

- the confirmed delegation envelope may preauthorize `script.evaluate` and/or
  `script.persist` effect classes within its exact origin/frame/checkpoint
  bounds;
- each revision remains fully inspectable, immutable, hash-bound, locally
  revalidated, and receipted, but does not require a redundant confirmation
  while it remains inside the envelope;
- arbitrary-code authority, site scope, frame scope, `MAIN`, bridge handlers,
  and CDP `Runtime.evaluate` are independent visible grants;
- `MAIN` or CDP is never a silent fallback from `USER_SCRIPT`; CDP is a distinct
  executor selected only when its exact grant is current;
- scope/world/bridge widening, an origin/document change, a checkpoint,
  destructive application effect, stale evidence, or an expired envelope pauses
  before execution.

Explain and Help do not receive arbitrary evaluation authority. They may render
packaged, anchor-bound annotations as response presentation. Collaborate needs
action-specific confirmation for a program effect. Delegate needs the confirmed
envelope and the exact program-class grants above.

Visual hide, DOM detach, insertion, restyling, drawing, and instrumentation are
page-program effects. Deleting application data remains a destructive site
action even when JavaScript performs it. Representation never downgrades risk.

## 7. Receipts And Retention

Every program attempt creates a canonical local receipt binding artifact,
revision, source hash, execution profile/executor, world, target
tab/document/frame/origin, the exact standalone-approval or
Delegate-envelope/grant authority variant, before/after evidence refs, bounded
result/error/console summary, registration read-back,
cleanup/rollback/removal result, timestamps, and status. Gateway sync is an
audit copy, not execution authority. Stop/review/rollback controls remain in
packaged extension UI outside the page.

Retention defaults:

| Record | Default |
| --- | --- |
| Semantic observation | Bounded turn/session retention |
| Screenshot bytes | Request-only; retain digest and bounded metadata |
| Video bytes | Short-lived with visible expiry and immediate deletion control |
| Search | Used URLs plus bounded query/invocation metadata |
| Program source/history | While installed and as needed for rollback |
| Program deletion | Unregister/remove source; retain bounded hash/status tombstone and receipts |
| Live anchors/page state | Local latest-only unless explicitly promoted |
| Receipts | Durable, bounded, secret-redacted |

Provider processing/retention is disclosed separately from Moa storage.
Receipts omit credentials, cookies, authorization data, unrestricted page
bodies, raw search result bodies, and unrestricted console output.

## 8. Rollout DAG

```text
contract reconciliation
  -> route-uniform search
  -> initial browser multimodal evidence
       -> broker evidence resolution / Android semantic alignment
       -> video continuation (after recorder final-chunk correctness)
  -> userScripts capability onboarding
  -> reviewed_standalone_v1 runtime proof
  -> delegated_runtime_v1 grants and runtime proof
  -> add / remove / draw behavior proof
  -> independent verification
  -> package / promote only if the active-promotion gate passes
```

Search and recorder correctness may be implemented in parallel after the
contract is fixed. Generated evaluation must wait for profile reconciliation,
onboarding, immutable artifact/receipt support, and the applicable runtime
profile. Integration and independent verification remain serial owners.
