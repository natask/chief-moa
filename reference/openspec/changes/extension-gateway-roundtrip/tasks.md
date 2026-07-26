## 1. Round Trip

- [x] 1.1 Set gateway URL + token in extension options; confirm `/health` succeeds (gatewayHealth). — verified live: `smoke:gateway` writes the gateway URL into `chrome.storage.local` and `GET http://10.147.17.6:8787/health` returns `200 {ok:true}`.
- [x] 1.2a Implement and deterministically assert overlay command routing through
      `POST /v1/voice/turns`. The recorder-backed `smoke:gateway` assertion
      proves the endpoint is exercised rather than stubbed.
- [ ] 1.2b With user-authorized `AGEE_GATEWAY_TOKEN`, confirm the overlay
      command receives a live `200` reply from `/v1/voice/turns` and renders it.
      Acceptance: a timestamped live receipt records the gateway origin,
      endpoint, response status, and rendered result without recording the token.
- [x] 1.3a Implement and deterministically assert describe-page routing through
      `POST /v1/chat`. The recorder-backed `smoke:gateway` assertion proves the
      endpoint is exercised rather than stubbed.
- [ ] 1.3b With user-authorized `AGEE_GATEWAY_TOKEN`, confirm describe-page
      receives a live `200` reply from `/v1/chat` and renders it.
      Acceptance: a timestamped live receipt records the gateway origin,
      endpoint, response status, and rendered description without recording the
      token.
- [x] 1.4 Disconnect/unauthorize the gateway and confirm a clear, non-silent error renders in the overlay. — verified live: with no token, the command hits `POST /v1/voice/turns` → `401`, and the overlay renders the clear error in the result stack above the preserved input draft with a red status dot.
- [x] 1.5 Note the confirmed round-trip sequence in `browser_extension/README.md`. — added a "Verify the gateway round-trip" section documenting the health → command → describe → loud-failure sequence and the `smoke:gateway` script.
- [x] 1.6 Route browser voice through the gateway streaming voice session, not browser-native STT/TTS. — implemented short-lived `/v1/voice/session-ticket` auth for browser WebSockets, streams PCM16 to `/v1/voice/sessions`, and plays returned assistant PCM audio. Verified by `gateway/scripts/smoke-browser-voice-ticket.js`.
- [x] 1.7 Replace the visible chat/log panel with a one-current-intent browser surface: Cmd+, opens text, Cmd+. starts icon-first voice, replies/errors render above the input without clearing or replacing its draft, and visible history is omitted unless explicitly requested through Moa. Verified by `npm run verify` and `npm run smoke:gateway`.
- [x] 1.9 Auto-commit browser voice turns after speech silence so the user does not need a second click/hotkey to send captured audio.
- [x] 1.8 Move browser microphone capture to an extension-owned offscreen document so websites do not receive mic permission. Content script now controls UI only; `offscreen.js` owns `getUserMedia`, sends PCM16 chunks to `background.js`, and the options page seeds the extension-origin microphone grant. Verified by `npm run verify` and `npm run smoke`.
- [x] 1.10 Show browser voice transcript/assistant feedback above the input while keeping the input available; the browser mark single-click path is reserved for opening the chat menu and does not commit current speech.
- [x] 1.11 Share one browser-agent owner across tabs: store the active owner in
      `chrome.storage.local`, broadcast owner changes to content scripts, revoke
      old-tab voice/task cues on transfer, prefer the owner tab for queued
      browser tasks, and verify with a two-tab real-extension smoke. Verified
      by `cd browser_extension && npm run verify && npm run smoke`.
- [x] 1.12 Add manual browser mark push-to-talk: double-clicking and holding the
      mark starts a gateway voice session with browser silence auto-commit
      disabled, releasing the mark commits the turn, and the manual turn does
      not re-arm the mic. A normal click-and-hold is only for moving the mark.
- [x] 1.13 Guard browser voice WebSocket sends so revoked or closed sessions do
      not call `send` on CLOSING/CLOSED sockets. Verified by `npm run verify`.
- [x] 1.14 Replace offscreen `ScriptProcessorNode` microphone capture with an
      `AudioWorkletNode` worklet path that still forwards PCM16 chunks to the
      background worker. Verified by `npm run verify`.
- [x] 1.15 Keep exactly one Aggie root on each top-level page after extension
      reload/reinjection, while blocking iframe duplicates. Verified by
      `npm run verify` and `npm run smoke`.
- [x] 1.16 Align Cmd/Ctrl+Period with the browser mark voice contract: quick
      tap/double-click toggles a manual voice turn, the next quick press commits
      it, holding Cmd/Ctrl+Period or the second mark click commits on release,
      and Cmd/Ctrl+Comma remains text-open only. Verified by `npm run verify`
      and `npm run smoke`.
- [x] 1.17 Buffer extension-owned offscreen microphone PCM captured before
      gateway `session_ready`, then flush it in order before any pending
      `commit_turn` so the first spoken audio is not dropped. Verified by
      `npm run verify` and `npm run smoke`.
- [x] 1.18 Keep microphone recovery on the active extension surface until the
      user chooses "Take me to microphone setup"; then open Options with a
      typed one-shot recovery target that shows permission state and focuses
      the existing user-operated Grant microphone control. No setting or
      automatic permission action is added. Verified by `npm run verify`.
- [x] 1.19 Match Android gesture-time voice capture: warm the extension-owned
      microphone on pointer-down when permission is already granted, retain the
      newest 500 ms of PCM, and drain it into voice turns and audio notes before
      connection-time audio. Do not prompt for microphone permission from an
      ordinary mascot press. Verify with unit, extension-contract, and real
      headless-Chrome smoke checks.

## 2. Unified Browser-Agent Turn Path

- [x] 2.1 Gateway: add `POST /v1/browser/evidence` to accept bounded page
      evidence from the extension, including URL, title, visible page text,
      actionable element summaries, and screenshot references.
- [x] 2.2 Gateway: add `POST /v1/browser/turns` as the canonical browser-agent
      turn route for typed page questions, describe-page requests, and committed
      browser voice transcripts.
- [x] 2.3 Gateway: add `GET /v1/browser/turns/{turn_id}/status` returning named
      turn states, latest progress text, result text, action proposals, and
      linked receipts.
- [x] 2.4 Extension: create one background orchestrator for text questions,
      committed voice transcripts, and describe-page requests, all using the
      browser evidence and browser turn endpoints.
- [x] 2.5 Extension: collect bounded page evidence from the content script before
      browser-agent turns and preserve the rule that page context is evidence,
      not instruction.
- [x] 2.6 Extension: show named progress states in the overlay and remove any
      reliance on an inert debug symbol as the only operational signal.
- [ ] 2.7 Extension/gateway: accept bounded click/draw/annotate action proposals
      as proposals only; keep local validation, approval, execution, and receipts
      browser-owned. The first implementation slice may store/refuse/defer action
      execution while preserving the receipt contract.
- [x] 2.8 QA: add a smoke proving a typed page question and a committed spoken
      page question both hit `POST /v1/browser/turns`; include describe-page on
      the same route if the smoke fixture can collect page evidence.
