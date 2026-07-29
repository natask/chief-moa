# Tasks

## 1. Quiet browser companion

- [x] 1.1 Show only Copy and voice reply on/off beside the companion while the panel is closed.
  - Acceptance: source and unit tests show exactly two persistent actions.
- [x] 1.2 Copy the latest spoken transcript, then fall back to the latest reply.
  - Acceptance: Copy succeeds without opening a ribbon or panel and reports when no text exists.
- [x] 1.3 Give the voice toggle immediate local stop authority.
  - Acceptance: turning voice off stops scheduled Web Audio sources and drops later audio frames while text continues.
- [x] 1.4 Persist voice reply choice in extension-local storage.
  - Acceptance: reinjection restores the choice without a gateway call.
- [ ] 1.5 Run browser verification, smoke, package, and loaded-extension reload confirmation.

## 2. Android parity

- [ ] 2.1 Put Copy and voice reply on/off beside the Android companion without restoring the old overlay card.
- [ ] 2.2 Stop Android TTS locally before any network request.
- [ ] 2.3 Copy the final transcript without opening history.
- [ ] 2.4 Verify on a phone and publish one continuity-signed OTA candidate.

## 3. Hosted account and enrollment

- [ ] 3.1 Complete one hosted account authority using the existing Better Auth and anonymous-session plan.
- [ ] 3.2 Link an anonymous browser trial to an account without losing its sessions.
- [ ] 3.3 Enroll Android and browser devices with device-bound credentials after sign-in.
- [ ] 3.4 Keep manual gateway URL and token setup only for self-host mode.

## 4. Public trial and downloads

- [ ] 4.1 Rewrite the landing page around voice-first background work and visible control.
- [ ] 4.2 Add a bounded browser trial with clear limits and no local action authority.
- [ ] 4.3 Publish Android and browser downloads with exact version and digest data.
- [ ] 4.4 Test the path from landing page to sign-in, enrollment, first voice turn, and receipt.

## 5. Companion control center

- [ ] 5.1 Show account-scoped intents and switchboards from the canonical intent plane.
- [ ] 5.2 Show agents, runs, progress, and interruption state from gateway-owned records.
- [ ] 5.3 Show history, account connections, usage, and cost from existing bounded projections.
- [ ] 5.4 Add voice input without moving approval or execution authority out of the owning device.

## 6. Speech completion

- [ ] 6.1 Define a text-only phrase suggestion contract with explicit provenance.
- [ ] 6.2 Show one short suggestion without changing the literal transcript.
- [ ] 6.3 Measure usefulness and false interruption rate before adding spoken suggestions.
