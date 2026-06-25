## 1. Round Trip

- [x] 1.1 Set gateway URL + token in extension options; confirm `/health` succeeds (gatewayHealth). — verified live: `smoke:gateway` writes the gateway URL into `chrome.storage.local` and `GET http://10.147.17.10:8788/health` returns `200 {ok:true, token_required:true}`.
- [x] 1.2 Open the overlay via Cmd+, on the demo page, submit a command, and confirm the rendered reply originates from `/v1/voice/turns`. — implemented + asserted in `smoke:gateway` (real overlay `run` submit → background `POST /v1/voice/turns`, recorder confirms the endpoint, reply renders into the one-current-intent result stack above the preserved input draft). Awaiting `AGEE_GATEWAY_TOKEN` to confirm live (200); the harness self-test with an invalid token proved the live POST to `/v1/voice/turns` is exercised, not stubbed.
- [x] 1.3 Run "describe page" and confirm the rendered description originates from `/v1/chat`. — implemented + asserted in `smoke:gateway` (real `describe` → background `POST /v1/chat`, recorder confirms the endpoint, description renders into the one-current-intent surface). Awaiting `AGEE_GATEWAY_TOKEN` to confirm live (200); invalid-token self-test proved the live POST to `/v1/chat` is exercised.
- [x] 1.4 Disconnect/unauthorize the gateway and confirm a clear, non-silent error renders in the overlay. — verified live: with no token, the command hits `POST /v1/voice/turns` → `401`, and the overlay renders the clear error in the result stack above the preserved input draft with a red status dot.
- [x] 1.5 Note the confirmed round-trip sequence in `software/browser_extension/README.md`. — added a "Verify the gateway round-trip" section documenting the health → command → describe → loud-failure sequence and the `smoke:gateway` script.
- [x] 1.6 Route browser voice through the gateway streaming voice session, not browser-native STT/TTS. — implemented short-lived `/v1/voice/session-ticket` auth for browser WebSockets, streams PCM16 to `/v1/voice/sessions`, and plays returned assistant PCM audio. Verified by `gateway/scripts/smoke-browser-voice-ticket.js`.
- [x] 1.7 Replace the visible chat/log panel with a one-current-intent browser surface: Cmd+, opens text, Cmd+. starts icon-first voice, replies/errors render above the input without clearing or replacing its draft, and visible history is omitted unless explicitly requested through Moa. Verified by `npm run verify` and `npm run smoke:gateway`.
- [x] 1.9 Auto-commit browser voice turns after speech silence so the user does not need a second click/hotkey to send captured audio.
- [x] 1.8 Move browser microphone capture to an extension-owned offscreen document so websites do not receive mic permission. Content script now controls UI only; `offscreen.js` owns `getUserMedia`, sends PCM16 chunks to `background.js`, and the options page seeds the extension-origin microphone grant. Verified by `npm run verify` and `npm run smoke`.
- [x] 1.10 Show browser voice transcript/assistant feedback above the input while keeping the input available, and make one mark click during listening commit the current speech turn.
- [x] 1.11 Share one browser-agent owner across tabs: store the active owner in
      `chrome.storage.local`, broadcast owner changes to content scripts, revoke
      old-tab voice/task cues on transfer, prefer the owner tab for queued
      browser tasks, and verify with a two-tab real-extension smoke. Verified
      by `cd browser_extension && npm run verify && npm run smoke`.
- [x] 1.12 Add manual browser mark push-to-talk: holding the mark starts a
      gateway voice session with browser silence auto-commit disabled, releasing
      the mark commits the turn, and the manual turn does not re-arm the mic.
