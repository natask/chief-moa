## 1. Round Trip

- [x] 1.1 Set gateway URL + token in extension options; confirm `/health` succeeds (gatewayHealth). — verified live: `smoke:gateway` writes the gateway URL into `chrome.storage.local` and `GET http://10.147.17.6:8787/health` returns `200 {ok:true}`.
- [x] 1.2 Prove the initial non-page command baseline through
      `POST /v1/voice/turns`. Page-context questions are now owned by the
      canonical `POST /v1/browser/turns` path completed in 2.2, 2.4, and 2.8;
      this historical baseline does not override that route.
- [x] 1.3 Move describe-page from the initial `/v1/chat` baseline to
      `POST /v1/browser/turns` with bounded page evidence. The current
      `smoke:gateway` and unified-browser-agent smoke assert the browser-turn
      route; `/v1/chat` is no longer the completed describe contract.
- [x] 1.4 Disconnect or unauthorize the gateway and confirm a clear, non-silent
      error renders in the overlay. The generic command smoke exercises a
      `/v1/voice/turns` 401, while page-context route ownership remains
      `/v1/browser/turns`.
- [x] 1.5 Document the current health, generic-command, describe-page, and loud-
      failure smoke paths without presenting the superseded `/v1/chat` route as
      the active describe contract.
- [x] 1.6 Route browser voice through the gateway streaming voice session, not browser-native STT/TTS. — implemented short-lived `/v1/voice/session-ticket` auth for browser WebSockets, streams PCM16 to `/v1/voice/sessions`, and plays returned assistant PCM audio. Verified by `gateway/scripts/smoke-browser-voice-ticket.js`.
- [x] 1.7 Replace the visible chat/log panel with a one-current-intent browser surface: Cmd+, opens text, Cmd+. starts icon-first voice, replies/errors render above the input without clearing or replacing its draft, and visible history is omitted unless explicitly requested through Moa. Verified by `npm run verify` and `npm run smoke:gateway`.
- [x] 1.9 Keep canonical browser-mark capture manual: starting from the mark
      disables silence auto-commit, and only the matching click-toggle or
      push-to-talk release commits the turn. Gateway conversation modes that
      explicitly opt into automatic continuation remain a separate path.
- [x] 1.8 Move browser microphone capture to an extension-owned offscreen document so websites do not receive mic permission. Content script now controls UI only; `offscreen.js` owns `getUserMedia`, sends PCM16 chunks to `background.js`, and the options page seeds the extension-origin microphone grant. Verified by `npm run verify` and `npm run smoke`.
- [x] 1.10 Show browser voice transcript/assistant feedback above the input
      while keeping the input available; a browser-mark single click starts
      current-thread capture and the next single click commits it once.
- [x] 1.11 Share one browser-agent owner across tabs: store the active owner in
      `chrome.storage.local`, broadcast owner changes to content scripts, revoke
      old-tab voice/task cues on transfer, prefer the owner tab for queued
      browser tasks, and verify with a two-tab real-extension smoke. Verified
      by `cd browser_extension && npm run verify && npm run smoke`.
- [x] 1.12 Apply the canonical browser-mark chord map: double click starts a
      fresh-thread capture and a later single or double click commits it once;
      triple click opens text without cancelling active work; a still hold is
      push-to-talk committed on release; movement across the drag threshold
      repositions the mark without submitting a voice turn.
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
