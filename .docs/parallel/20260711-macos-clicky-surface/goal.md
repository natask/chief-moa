# Chief Moa macOS Clicky-like Surface

## Outcome

Ship the smallest buildable native macOS surface that reproduces Clicky's useful
trust-sensitive loop with user-owned infrastructure:

1. the user explicitly grants one foreground application for observation;
2. Moa reads a bounded Accessibility tree and may capture only that focused
   window when the separate screenshot option is enabled;
3. the user chooses local-only, ask-before-send, or a visible time-bounded
   trusted-server release grant;
4. released context goes only to the configured Chief Moa/Aggie gateway;
5. the gateway returns an inert proactive suggestion; and
6. any later UI mutation remains a locally approved public Accessibility action
   with a one-shot receipt.

## Non-goals

- Do not copy the installed closed-source Clicky binary, vendor credentials,
  proprietary prompts, branding, assets, or telemetry.
- Do not use private SkyLight/SLS symbols, `dlopen`, AppleScript, shell-driven UI
  automation, or a hidden login item.
- Do not launch the candidate, request TCC permissions, alter the user's live
  grants, reload a live app, or promote the production gateway in this slice.
- Do not make screen capture mandatory. Accessibility-only observation remains
  fully useful and is the default.

## Worktrees and ownership

- Staging branch: `agent/macos-clicky-surface-20260711`
- Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/macos-clicky-surface-20260711`
- Native lane owns `apple_surfaces/**`.
- Orchestrator owns gateway, OpenSpec, architecture, integration, commits,
  packaging, and promotion evidence.
- Do not touch Android, browser runtime, installed Clicky/OpenClicky state,
  `.env*`, provider credentials, or active deployment configuration.

## Acceptance

- `MoaMac` builds as a native macOS executable and deterministic `.app` bundle.
- Startup is paused and performs no AX read, screen capture, or network request.
- Grants are memory-only, app/PID/identity bound, visible, revocable, and at most
  15 minutes.
- AX output is bounded and secure/editable values are suppressed locally.
- Screenshot capture is independently opt-in and focused-window-only.
- No destination is packaged; only a user-configured canonical HTTPS or loopback
  Chief Moa origin is accepted.
- Ask mode previews the exact immutable request; trusted-server mode explicitly
  names the destination and expiry before it begins.
- Redirects fail, bodies and responses are bounded, and queued sends are
  invalidated by Stop, expiry, identity change, or app switch.
- Suggestions are inert. Public semantic AX actions require current-state
  validation and local approval; SkyLight is absent.

## Verification

```sh
cd apple_surfaces
swift test
swift build --product MoaMac
bash scripts/package-moa-mac.sh

cd ../gateway
npm run smoke:macos-proactive
npm run check

openspec validate privacy-first-macos-surface --strict
```
