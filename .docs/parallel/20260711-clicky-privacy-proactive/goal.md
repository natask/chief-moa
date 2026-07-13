# Privacy-First Proactive Assistance

## Desired outcome

Prove a useful browser suggestion card can be generated from a short-lived,
explicit current-tab grant without uploading page activity. Fresh and migrated
installs must make no passive gateway calls. If the user separately opts into
background connectivity/automation, the page indicator must say **local page
observation** without exposing extension configuration to the host page or
implying that the whole extension is offline; the extension-owned confirmation
discloses current background gateway connectivity. Heartbeats must not carry
the observed tab's URL, title, text, owner metadata, or affordance signals. A
dismissal must remain local. Acceptance must disclose the configured gateway
host and the exact bounded context being sent, then create exactly one strict
text-only proactive turn; it must not launch an agent, create a task/run,
persist a conversation turn, or execute a browser action.

## Non-goals

- No macOS desktop client in this slice.
- No model inference while observing.
- No screenshot, raw page body, selected text, URL, title, form value, or audio
  capture for proactive classification. Only bounded structural counts and a
  coarse local page-kind enum may feed the deterministic classifier.
- No gateway database/schema migration, Android, voice, or active deployment
  change. A narrow non-persisting gateway route is required so the no-agent
  boundary is enforced server-side rather than trusted to the browser.
- No cleanup or modification of the installed HeyClicky app or its data.

## Slice ownership

- Branch: `agent/privacy-proactive-helper-20260711`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/privacy-proactive-helper-20260711`
- Target files: browser extension code, browser verification, OpenSpec, and the
  architecture delta required by this feature.
- Gateway route ownership: separate `agent/proactive-gateway-20260711` worktree;
  integrate serially after independent verification.
- Do not touch: `android_app/**`, installed browser/Clicky state,
  runtime configuration, provider credentials, or `.env*`.

## Live-app constraints

- Do not reload the user's installed extension while implementing or testing.
- Runtime QA must use the existing throwaway headless Chrome + stub/throwaway
  gateway pattern.
- Release packaging may be created only after the slice is committed and the
  manifest version advances.
- Active browser reload/promotion is blocked unless it can be proven not to
  interrupt current browser work.

## Acceptance criteria

1. Fresh/default state has proactive help and background page automation off.
2. The user explicitly grants one current tab for at most 10 minutes; navigation,
   tab close, manual stop, or service-worker restart clears the grant.
3. Local classification receives only bounded non-textual affordance counts and
   coarse page kind. Sensitive/auth/payment/password pages are suppressed.
4. A persistent visible indicator identifies the current-tab scope and says the
   page observation stays local while the grant is active; it does not claim the
   extension as a whole is offline.
5. Observing and dismissing produce no gateway/page-derived network request.
6. A page card can only open an extension-owned confirmation. Final acceptance
   shows the full exact request and sends exactly one strict
   `/v1/proactive/turns` request. The gateway cannot create a task, workflow,
   broker event, conversation turn, agent run, or action on this route.
7. Gateway task/tool polling and device heartbeat are disabled by default and
   require a versioned background-automation consent. When enabled, the
   heartbeat excludes page and active-owner metadata.
8. Existing gateway configuration is preserved locally during migration, but
   is not contacted passively; a fresh install does not silently persist or
   contact a packaged hosted destination.
9. Tests prove migration, the data boundary, sensitive suppression, lifecycle,
   zero-network observe/dismiss behavior, redacted opted-in heartbeat, and
   exactly-once acceptance.

## Verification

```sh
cd browser_extension
npm run verify
npm run smoke
npm run smoke:proactive
npm run package
```

Run strict OpenSpec validation for the new change when the CLI is available.
