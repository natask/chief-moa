## Context

Contract source: `scratch/agent-loop/2026-07-06-per-surface-agents/CONTRACT.md`
(2026-07-06). That file is the single source of truth for shapes; this design
condenses it for OpenSpec review. Do not let this document and the contract
drift — update both together.

## Goals / Non-Goals

**Goals:**

- Give the browser a background agent loop that can drive a hidden tab
  through a bounded observe/act cycle, reusing the extension's existing
  content-script act path and CDP screenshot capability.
- Let the model reach phone and browser tools by name, with the offered set
  depending on which surface the turn came from, without forking chat
  history per surface.
- Keep the proposal boundary intact: fixed skills remain declarative; code and
  CDP use the separately versioned, profile-granted surface-program envelope.

**Non-Goals:**

- No streaming multi-action steps; exactly one action per step.
- No client-side keyword detection for surface routing; `call.source` is the
  single signal `resolveTurnSurface` reads.
- No change to the page Q&A path (`/v1/browser/turns`, `/v1/browser/evidence`).

## 1. Browser agent-loop tasks (gateway <-> extension)

New store: `DATA_DIR/browser-agent-tasks/` (one JSON file per task), new lib
`gateway/lib/browser-agent-loop.js`. All endpoints sit under authorizedAgent.

### Endpoints

- `POST /v1/browser/agent-tasks`
  body: `{ instruction, url?, source?, conversation_id?, branch_id?, max_steps? }`
  -> `{ task }` with record:
  `{ id, status: "pending"|"claimed"|"done"|"failed"|"cancelled", instruction,
     url, source, conversation_id, branch_id, agent_run_id, max_steps (<=40,
     default 24), step_count, steps: [...], claimed_by, claimed_at,
     lease_expires_at, summary, error, created_at, updated_at, finished_at }`.
  Creates a linked non-blocking `agent_run` (echo-harness style observability
  record) and appends `browser_agent_task_queued` to it.
- `POST /v1/browser/agent-tasks/claim` body `{ client_id }` -> `{ task }` or
  `{}`; 120s lease, renewed on every step post.
- `POST /v1/browser/agent-tasks/{id}/steps` body `{ observation }` ->
  `{ action, step, done }`. Gateway sanitizes the observation, appends
  `{ step, observation, action }` to the task, calls the reasoning model with
  the act/finish tools, returns the next action. When no reasoning provider
  is configured, a deterministic fallback plans: step 0 -> `wait`, step >0 ->
  `finish` with a summary naming the observed title (the keyless smoke path).
- `POST /v1/browser/agent-tasks/{id}/finish` body
  `{ status: "done"|"failed"|"cancelled", summary? }` -> final record; appends
  `browser_agent_task_finished` to the linked run and folds the summary into
  run output.
- `GET /v1/browser/agent-tasks` (+ `?status=`), `GET /v1/browser/agent-tasks/{id}`.

### Action vocabulary (gateway proposes, extension validates and executes)

```
{ kind: "click",     index: int }
{ kind: "type",      index: int, text: string<=2000 }
{ kind: "clear",     index: int }
{ kind: "select",    index: int, text: string<=200 }
{ kind: "scroll",    direction: "up"|"down" }
{ kind: "navigate",  url: http(s) URL }
{ kind: "key",       text: string<=32 }          // e.g. "Enter"
{ kind: "wait" }
{ kind: "screenshot" }                            // ask for a screenshot next obs
{ kind: "finish",    summary: string<=2000, status: "done"|"blocked" }
```

Both sides enforce: unknown kind -> reject (extension posts finish
status=failed with reason; gateway never emits unknown kinds). `navigate` is
http/https only.

### Observation shape (extension -> gateway)

```
{
  url, title,
  elements: [{ i, tag, type, label<=80 }]  // <=100 entries
  page_text?: string<=6000,
  screenshot?: { encoding: "base64_jpeg", data } | { encoding: "omitted", reason },
  last_action?: <action>,
  last_action_result?: string<=500,
  step: int
}
```

Gateway caps: screenshot base64 <=420KB (reuses the existing evidence cap),
keeps only the LATEST screenshot in model context, and bounds step history
(last 8 steps kept full, older steps summarized to one line each).

### Extension driver

- A new poll, `pollBrowserAgentTasks()`, runs on the existing 2s cadence,
  gated by a new setting `ageeBackgroundAutomationEnabled` (default true,
  exposed in options). The same setting also gates the legacy
  `pollBrowserTasks()` batch path.
- On claim: open a background tab (`active:false`), never activate it; drive
  the loop: build an observation (content-script snapshot when reachable,
  else `{url,title}` from the tabs API); take a screenshot via the existing
  `captureScreenshotViaDebugger` when the last action was `screenshot` or on
  step 0; POST the step; validate the returned action; execute element
  actions through the existing content-script act path; execute `navigate`
  via `chrome.tabs.update` plus wait-for-load; on `finish`, POST finish and
  dispose the tab.
- The tab persists across steps (the task carries state, not the tab). On any
  error, post finish `{status:"failed"}` and dispose. A stop-intent cancels
  the task through the existing cue map.

## 2. Per-surface skills (gateway)

New lib `gateway/lib/surface-skills.js`:

- `resolveTurnSurface(call)` -> `"browser" | "android" | "unknown"`, read from
  `call.source` (`android-overlay`/`android` -> android; `agee-extension`/
  `browser` -> browser). This is the one canonical helper; the existing
  `isBrowserSourcedCall` delegates to it instead of duplicating the check.
- `surfaceExecuteCapabilities(call, deps)` returns code-mode capabilities
  merged into `cascadedExecuteCapabilities`:
  - Always available, because cross-device control is the point of the hub:
    - `phone_open_app({ app })` -> `tool_request` kind `app.launch`, target
      android.
    - `phone_open_url({ url })` -> `tool_request` kind `url.open`, target
      android.
    - `phone_dial({ number })` -> `tool_request` kind `phone.dial`, target
      android.
    - `phone_open_contact({ name })` -> `tool_request` kind `contact.open`,
      target android.
    - `browser_agent_task({ instruction, url? })` -> creates a browser
      agent-loop task, returns `{ task_id, agent_run_id }`.
    - `browser_open_tab({ url })` -> `tool_request` kind `browser.tab.open`,
      target browser_extension.
  - Each phone/browser `tool_request` capability waits up to about 10s for a
    receipt (400ms poll) and returns `{ queued: true, request_id }` on
    timeout instead of failing the turn.
- Classic (non-code-mode) tool defs, so the path works even when `execute` is
  off: `phone_action` (enum tool: `app.launch` | `url.open` | `phone.dial` |
  `contact.open`, plus input) and `launch_background_browser_task`
  (`{instruction, url?}`). Both are added to the cascaded tool loop next to
  the existing `cascadedAgentRunTools`.
- `VOICE_EXECUTE_TOOL` default flips to ON (`!== "0"`, was `=== "1"`);
  `.env.example` documents the flip.
- `/health` additions: `execute_tool: { enabled, capability_count }` and
  `browser_agent_tasks: { pending, active }`.

### Phone tool mapping table

| code-mode capability      | classic tool `tool` value | android tool   |
|----------------------------|---------------------------|----------------|
| `phone_open_app`          | `app.launch`               | `app.launch`   |
| `phone_open_url`          | `url.open`                 | `url.open`     |
| `phone_dial`              | `phone.dial`               | `phone.dial`   |
| `phone_open_contact`      | `contact.open`             | `contact.open` |

## 3. Android tools

New broker tools, advertised in both `MoaActionBroker` and
`androidLocalToolManifest`:

- `url.open` input `{ url }` — ACTION_VIEW, http/https only. Risk
  `navigation`, approval `implicit_user_command`.
- `phone.dial` input `{ number }` — ACTION_DIAL `tel:` (no `CALL_PHONE`
  permission; the user presses call). Risk `external_side_effect`, approval
  `target_app_confirmation`.
- `contact.open` input `{ name }` — ContactsContract filter lookup, opens the
  contact card (QuickContact / ACTION_VIEW content uri). Requires
  `READ_CONTACTS`; when not granted, returns a clear "needs contacts
  permission" execution result and never crashes. Risk `navigation`, approval
  `implicit_user_command`.

Manifest adds `READ_CONTACTS` plus a runtime request affordance in
`MainActivity`'s settings/setup surface. Receipts record like every existing
tool. Unit tests cover the new pure helpers: URL allowlist, number
normalization, and tool dispatch.

## 4. Page Q&A

Already shipped (`/v1/browser/turns` + `/v1/browser/evidence`). This change
only re-verifies `npm run smoke:unified-browser-agent` and fixes regressions
if the new agent-loop poll or surface-skills wiring breaks it.

## Trust Boundaries

- Fixed-tool actions are bounded and declarative. The gateway's action vocabulary (browser)
  and tool_request kinds (phone/browser) are closed enumerations with typed,
  length-capped params. These fixed-action fields do not carry CSS/JS/code;
  granted code uses the surface-program envelope.
- The extension validates locally. Every proposed browser action is checked
  against the extension's own local allowlist before any DOM interaction;
  unknown kind is a hard reject (finish status=failed), never a best-effort
  execute.
- The Android broker validates locally. Every claimed tool_request is checked
  against the broker's own capability manifest and risk/approval policy
  before executing; a missing permission degrades to a structured result, not
  a crash or a silent no-op.
- Keys stay on the gateway. Raw provider (OpenAI/Anthropic/Gemini) credentials
  never reach Android or the browser extension; only `tool_request` records
  and `browser_agent_task` records cross the wire, both bounded and
  declarative. Browser programs use the separate surface-program profile and
  do not smuggle source or CDP commands through these fields.

## Two-App Split — Recorded Decision

See `proposal.md`'s decision record. Summary for design purposes: no wire
contract changes as a result of this decision; the single Android app keeps
serving `MoaActionBroker` and `androidLocalToolManifest` for every tool in
this change, including the three new ones.

## Migration Plan

1. Land `gateway/lib/browser-agent-loop.js` and its endpoints first; it has
   no dependency on the surface-skills registry and is independently
   smoke-able keyless.
2. Land `gateway/lib/surface-skills.js` and wire it into the cascaded execute
   capability set and the classic tool loop; flip `VOICE_EXECUTE_TOOL`
   default in the same commit since the classic fallback tools cover the
   off case.
3. Land the extension's `pollBrowserAgentTasks()` driver and settings toggle
   against the now-live gateway endpoints.
4. Land the three Android broker tools and the `READ_CONTACTS` manifest
   change.
5. Re-run the page Q&A smoke and fix any regression before merging.
6. Docs (this change plus `ARCHITECTURE.md`) land with or before the gateway
   lane so shipped behavior and docs never disagree.

## Open Questions

- Should `browser_agent_task` support a caller-supplied step budget below the
  40-step ceiling, or is the fixed `max_steps` default (24) sufficient for
  the first slice? Left at the contract default; revisit once real research
  tasks show typical step counts.
- Should the classic `phone_action` tool collapse to one tool with an enum, or
  four separate tools matching the code-mode capability names? The contract
  specifies one enum tool; kept as-is for a smaller tool-loop surface.
