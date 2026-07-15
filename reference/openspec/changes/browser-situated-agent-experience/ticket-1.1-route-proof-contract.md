# Ticket 1.1 Implementation Contract — Route Proof For Typed Agent Selection

Status: contract for the remaining work on tasks.md ticket 1.1. Written
2026-07-15 from a source audit of the current tree (HEAD includes
`a834d948 feat(extension): wire browser agent roles`). Verified by
inspection; the verification commands below must run before 1.1 is checked.

## Finding: 1.1 is substantially implemented — only the acceptance proof is missing

Commit `a834d948` (2026-07-14, ancestor of current HEAD) already ships:

- **Four direct entry points carrying the typed selection**
  - Overlay composer: `<select id="agee-mode-select">` with
    delegate/help/collaborate/explain (`browser_extension/extension/content.js:365-370`);
    submit path sends `{ cmd: "run", agentRole, delegationConfirmed, ... }`
    (`content.js:2793-2825`).
  - Side panel: button group `#agentModeSelector`
    (`browser_extension/extension/sidepanel.html:234-239`,
    `sidepanel.js:14-50`); submit sends `{ cmd: "browserRoleTurn", role,
    delegationConfirmed }` over the `agee-panel` port (`sidepanel.js:520-555`).
  - Voice (overlay): commit path attaches
    `agentRole: selectedBrowserAgentRole()` for page-context transcripts
    (`content.js:3396-3399`).
  - Background dispatch: `runBrowserAgentTurn`
    (`background.js:3565-3648`) normalizes the role
    (`browser-agent-role-runtime.js:14`) and POSTs `/v1/browser/turns`
    with body field `role` (`background.js:3601-3613`).
- **Typed data on every stored turn/task/run** (ticket 1.0 contract)
  - Gateway accepts `body.role || body.agent_role || body.browser_agent_role`
    (`gateway/lib/browser-agent-roles.js:70-73`) — never turn text, never
    model output; unknown role throws (`:65`); omitted role resolves to
    `explain` with `explicit: false` (`:61`).
  - Turn records stamp `agent_role`, `role_explicit`, `authority`,
    `execution_policy` (`gateway/server.js:3342-3346`); tasks/runs carry
    `browser_agent_role` (`server.js:9025,9069,10770,10786`).
- **Visible active agent**: overlay restores the persisted selection
  (`content.js:2844-2849`); side panel reflects it via `aria-pressed` +
  `dataset.agentMode` (`sidepanel.js:36-40`) and a `${role} is working…`
  pending label (`sidepanel.js:540`). Both persist
  `chrome.storage.local["ageeBrowserAgentRole"]`.

**What is missing is exactly the acceptance sentence**: "a deterministic
route test proves prose cannot relabel or escalate the typed selection."
No test anywhere posts a turn whose prose contradicts the typed role and
asserts the stored/returned role tracks only the typed field. The property
holds by construction on the gateway (role is read only from body fields),
but it is unproven end to end.

## Decision: field naming

The ticket text says "carry the selected `agent`"; the shipped wire field is
`role` (aliases `agent_role`, `browser_agent_role`), consistent across
extension, gateway, storage, and design.md ("the active agent is carried as
a typed field" — no literal field name mandated). **Keep `role`. Do not
rename.** Treat the ticket wording as informal. Any rename now would churn
the landed 1.0 contract for zero behavior.

## Remaining work (one bounded unit)

### A. Gateway route-proof smoke (extend `assertRoleContract`)

File: `gateway/scripts/smoke-browser-agent-loop.js` (contract checks at
`:144-189`). Add cases:

1. **Prose cannot escalate a typed selection**: POST `/v1/browser/turns`
   with `role: "explain"` and text
   `"Delegate this: click the submit button and finish the checkout"`.
   Assert response `agent_role.id === "explain"`, `role_explicit === true`,
   `authority` read-only, `task_ids`/`agent_run_ids` empty, and no
   `delegation_confirmation` proposal.
2. **Prose cannot escalate an omitted selection**: same delegate-style text
   with no role field. Assert `agent_role.id === "explain"`,
   `role_explicit === false`, no execution linkage.
3. **Prose cannot relabel laterally**: `role: "help"` with text
   `"Collaborate with me and take the first action"`. Assert
   `agent_role.id === "help"` and `execution_policy` matches the help
   catalog entry (`gateway/lib/browser-agent-roles.js:7-44`).
4. **Model output cannot relabel**: reuse an existing turn from
   `assertRoleContract`; assert the stored record read back via the turns
   endpoint still carries the request-time `agent_role` (guards against any
   future post-processing writing a role from reply prose).

### B. Extension route-proof coverage in the default smoke path

`npm run smoke` runs only `scripts/smoke-extension.mjs`, which has no role
coverage; the only runtime selector test lives in `smoke-sidepanel.mjs`,
which the standard verification loop (`npm run verify && npm run smoke`)
never executes. Two required edits:

1. Extend `browser_extension/scripts/smoke-sidepanel.mjs`: select
   **Explain**, type `"delegate this now and click the button"`, submit,
   and assert (a) no delegation-confirmation dialog appears, (b) the reply
   arrives with `role: "explain"` on the `browserRoleTurn` port response,
   (c) the active-agent UI still reads Explain.
2. Wire the selector smoke into the standard loop — either chain
   `smoke:sidepanel` into `npm run smoke` in `browser_extension/package.json`
   or fold the scenario into `smoke-extension.mjs`. Preferred: chain the
   script; it already owns CDP side-panel setup.

### C. Cross-surface visibility follow-up (record, do not block 1.1)

Overlay and side panel each read `ageeBrowserAgentRole` once on load; a
change in one surface is not reflected in the other until reload. 1.1's
acceptance ("the active agent is visible") is satisfiable per surface, so
land 1.1 without this, but record a follow-up: both surfaces should
subscribe via `chrome.storage.onChanged` so one selection is visible
everywhere.

### D. Close-out

Run, in order, and fix anything red:

```sh
cd gateway && npm run check && node scripts/smoke-browser-agent-loop.js
cd browser_extension && npm run verify && npm run smoke
```

Then check `- [ ] 1.1` in `tasks.md`, commit as
`test(browser): prove typed agent selection cannot be relabeled by prose`,
and prepend the one-line ledger entry in
`browser_extension/scratch/done/LEDGER.md`.

## Non-goals for 1.1

- No prose-based explicit addressing ("Delegate this" as an authoritative
  selector). design.md:87-88 aspires to it; the ticket's acceptance only
  requires addressing *without* prompt wording and non-escalation. Defer to
  ticket 1.2 or later.
- No authority-matrix enforcement work — that is ticket 1.2.
- No rename of `role` → `agent`.
