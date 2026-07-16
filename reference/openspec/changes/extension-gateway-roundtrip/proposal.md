## Why

With the extension loaded, the next proof is that the on-page overlay actually
talks to the user's gateway end to end. The implemented round-trip proof started
with split command and describe paths. The next slice unifies typed page
questions, describe-page requests, and committed browser voice transcripts
through one browser-agent turn path.

This is the **first concrete slice of `thin-client-gateway-architecture`**: it
proves the load-bearing route — the thin-client extension reaching its persistent
engine — that everything else (settings, customization, deployment) is built on.
The point being confirmed is not just "a reply renders" but "the reply came from
the engine," i.e. the browser routed the action through the engine rather than
acting on its own.

## What Changes

- With a gateway URL + token configured, open the overlay via Cmd+Comma, submit a
  page question, and confirm the reply came from `POST /v1/browser/turns`.
- Run "describe page" and confirm the output came from the same
  `POST /v1/browser/turns` route with page evidence attached.
- Commit a browser voice transcript and confirm the resulting page question uses
  the same browser-agent turn path as typed text.
- Post bounded page evidence to `POST /v1/browser/evidence`; URL, title, visible
  page text, actionable element summaries, and screenshot references are evidence,
  not instructions.
- Expose named browser-turn progress through a status endpoint so the overlay can
  show real states instead of an inert debug symbol.
- Treat gateway/model browser actions as proposals only. The extension validates,
  approves, executes, and receipts bounded click/draw/annotate actions locally;
  the first implementation slice may leave actual execution as a follow-up.
- Capture a clear failure message when the gateway is unreachable or unauthorized.
- Keep provider calls and canonical browser-agent state gateway-owned while the
  packaged extension owns browser-local capture, UI, validation, and execution.

## Capabilities

### New Capabilities

- `extension-gateway-roundtrip`: A confirmed end-to-end path from the overlay
  through the configured gateway for typed page questions, describe-page
  requests, and committed browser voice transcripts.

## Impact

- `gateway` browser turn/evidence/status endpoints and
  `browser_extension/extension` background/content orchestration. Depends on
  `extension-browser-baseline`; first slice of `thin-client-gateway-architecture`.
