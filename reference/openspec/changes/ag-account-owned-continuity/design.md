## What the device actually persists today

Audited at `android_app/app/src/main/java/ag/companion/`. Every site below is
`MODE_PRIVATE` app-private storage, so none of it is reachable by another
package — including the new `ag.companion` package reading the old one.

| Store | File:line | Holds | Classification |
| --- | --- | --- | --- |
| `MoaDeviceCredentialStore` | `MoaDeviceCredentialStore.java:25` | Scoped `ag_dev_v1.*` device credential, enrollment origin/device/account, legacy release-control credential | **Must stay local.** It is the device's own secret; sending it anywhere defeats it. Recoverable only by re-enrolling. |
| `MoaPrefs` gateway token | `MoaPrefs.java:28` | Legacy `MOA_GATEWAY_TOKEN` bearer | **Must stay local**, and should be retired in favour of the scoped device credential. The bearer is owner-wide; the device credential is not. |
| `MoaPrefs` settings/profile cache | `MoaPrefs.java:37-52` | `agent_profile_json`, companion, spoken-reply, orb scale, gesture mode, YouTube preference, first-conversation flag | **Should be server-owned.** `agent_profile_json` is already a cache of `/v1/agent/profile`. The rest — orb scale, gesture mode, spoken replies, preferred player — are *wrongly local today*: they are user settings with no server field, so a reinstall loses them. |
| `MoaPrefs` conversation pointers | `MoaPrefs.java:29-32` | conversation/branch/session ids, `history_json` | **Transient/derivable.** The gateway owns the conversation; these are a resume hint and a render cache. |
| `MoaPrefs` update bookkeeping | `MoaPrefs.java:44-48` | deferred/notified version codes, previous version+sha | **Transient.** Rebuilt from the release channel; only meaningful for the installed binary. |
| `MoaToolReceiptOutbox` | `MoaToolReceiptOutbox.java:29` | Bounded retry state for cross-device tool receipts not yet acknowledged | **Must stay local until drained.** This is unsent work. Same shape as unsent audio: hold, retry, reconcile, then forget. |
| `MoaActionReceiptStore` | `MoaActionReceiptStore.java:15` | Local action receipts | **Should be server-owned** once delivered; local copy is the pre-delivery buffer and the offline audit trail. |
| `MoaMediaDeleteJournal` | `MoaMediaDeleteJournal.java:15` | Approved-but-unconverged gateway bookmark deletes | **Must stay local until converged.** An intent the user already approved that the server has not seen. |
| `MoaMediaSpotStore` | `MoaMediaSpotStore.java:26` | YouTube media spots and spoken labels | **Should be server-owned.** *Wrongly local today* — these are user-created named bookmarks and a reinstall loses all of them. |
| `MoaVoiceE2eMetricsStore` | `MoaVoiceE2eMetricsStore.java:15` | Bounded rolling voice outcomes, no content or identity | **Transient.** Diagnostics; rebuilt by use. |
| `MoaDeferredVoiceCaptureBuffer` | `MoaDeferredVoiceCaptureBuffer.java:15` | In-memory PCM for a warmed/held microphone | **Must stay local**, and is *not durable today*: it is process memory, so audio held during an offline turn does not survive a process death. |

Two honest gaps fall out of this table:

1. **Real user settings have no server field.** Orb scale, voice-first gestures,
   spoken-reply preference, preferred player, and media spots are settings the
   user chose. They are local-only, so they die with the package. They belong in
   the account profile.
2. **Unsent capture is memory, not storage.** `MoaDeferredVoiceCaptureBuffer` is
   bounded and freezes on overflow, which is correct for truncation safety, but
   nothing persists a captured-while-offline turn across a process restart.

## Restore comes from the account, never from the old package

```text
ag.companion (clean install)
  -> POST /v1/device-enrollments/exchanges     one-use capability -> Device credential
  -> GET  /v1/device-enrollments/continuity    what this account can restore
  -> GET  /v1/device-enrollments/continuity/settings   the settings themselves
```

The device holds only its own scoped `Device` credential. It never receives the
owner bearer token, and it never reads `ai.moa.assistant` storage — it cannot.
Every continuity response repeats `local_state_transferred: false`, so the app
can state truthfully that nothing was copied from the old app.

The settings projection is a bounded allowlist, not the whole profile. Routing,
provider, trust, and prompt fields (`model`, `temperature`, `*_provider`,
`tool_policy`, `autonomy_level`, `memory_policy`, `recovery_mode`,
`system_prompt`) stay server-applied. A device copy of those would only drift, or
make server state look like local authority. Provider API keys are never in the
profile and never on the device.

## Settings schema migration ships with the release

Two versions travel together:

- `settings_schema_version` on the snapshot — the shape the **server** sent.
- `AgSettingsRestore.CLIENT_SCHEMA_VERSION` — the shape **this build** knows.

`AgSettingsRestore.MIGRATIONS` is the ordered list of upgrade steps the release
carries. A client replays only the steps between the server's version and its
own, so an upgrade runs exactly once and a step it has already applied is
skipped.

| Case | Behavior |
| --- | --- |
| server == client | Apply directly. |
| server < client | Replay the client's migration steps forward, then apply. The rename ships with the release that introduced it. |
| server > client | Apply the snapshot verbatim, keep unrecognized fields untouched, and report `RESTORED_PARTIAL` with "update Ag to apply all of them". |
| unverifiable snapshot | Change nothing. Stored settings are untouched and the app says the restore did not happen. |

Fail-safe is the rule in every row: a value is never blanked by an empty
incoming value, a stored key the snapshot omits is never removed, and an
unrecognized field is never discarded — the account still owns it.

## Unsent audio: bounded, offline-durable, reconciling

Unsent audio is the one thing that is genuinely lost if the device drops it, so
it gets the only durable local queue:

- **Bounded.** A byte ceiling per draft and a total ceiling across drafts. On
  overflow the draft freezes and fails loudly rather than sending truncated
  audio, matching `MoaDeferredVoiceCaptureBuffer`'s existing contract.
- **Offline-durable.** A promoted draft is written to app-private storage with a
  client-generated turn id before upload is attempted, so a process death does
  not lose it.
- **Reconciling, not duplicating.** The client-generated turn id is the
  idempotency key. Replaying it after connectivity returns yields the same turn,
  and the entry is deleted only after the gateway acknowledges that id. This is
  the same reserve/complete/acknowledge shape `MoaToolReceiptOutbox` already
  uses, and it should reuse it rather than grow a second queue.
- **Retained, then dropped.** An entry that cannot be delivered within its
  retention window is surfaced to the user as a failed turn and removed. It is
  never silently retried forever.

## Multi-user readiness

Check first, and the check says: **partly ready, one real gap.**

Ready — enrollment is already per identity. `createDeviceEnrollmentService`
binds each capability and credential to a `tenant_id`/`owner_id`
(`gateway/lib/device-enrollment.js`), and the continuity routes resolve the
account from the presented credential, never from the request body
(`gateway/lib/device-enrollment-handlers.js`). A second person enrolling gets
their own credential, their own scopes, and their own account id.

Not ready — the profile store is single-account. `createAgentProfileStore` keys
versions by `global` or `device` scope only (`gateway/lib/agent-profile.js:56`),
persisted to files in `DATA_DIR`, and every profile route authorizes on one
shared `MOA_GATEWAY_TOKEN` (`gateway/server.js:12865`, `server.js:12971`). Two
users on one gateway would share one profile.

The restore endpoint is shaped for this: it receives the authenticated principal
and asks a `readAccountSettings(principal)` seam for that account's settings.
Today that seam returns the global profile. Per-owner scoping lands behind the
seam, and no client change is needed when it does. Do not build accounts — they
exist; finish scoping the profile store to them.

## Boundaries kept

The gateway credential is the only secret on the device. Restored settings are
data the client applies to itself, never an instruction to execute — server
output stays a proposal. Nothing here introduces on-device TTS; hosted TTS or
text remains the only path.
