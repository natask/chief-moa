# Design

## Product shape

The companion is the quick control. The full app or control center is the record.

The quick control has two persistent actions:

- Copy copies the latest spoken text. It falls back to the latest reply when no spoken text exists.
- Voice turns spoken replies on or off. Turning it off stops local playback at once.

The existing mark shows idle, listening, thinking, and speaking state. The existing bounded ribbons may show current text, then retire. The quick control adds no history, settings, run list, or account form.

## Current surface audit

### Browser

The extension already has a movable companion, bounded transcript and reply ribbons, local clipboard writes, local Web Audio playback, voice-session cancellation, typed and spoken stop phrases, and a gateway-backed side panel. Copy currently requires opening a ribbon or panel. Voice controls live inside the panel. This makes the browser the smallest complete slice.

### Android

Android already has an overlay, voice capture, local TTS controls, guided setup, session and run views, approvals, receipts, and OTA delivery. Its overlay release also depends on package and signer continuity. Android parity should follow after the browser control proves the interaction.

### Account and enrollment

The gateway has one token-based authority path, device enrollment, account-connection records, and plans for anonymous sessions plus Better Auth. Hosted account identity is still staged. Android and browser setup still expose gateway configuration. This change must reuse the hosted account plan and device enrollment contract.

### Website and downloads

The public website code lives under `gateway/public`. It includes the landing surface and companion studio. The repository has Android OTA artifacts and browser extension packaging. It does not yet give a new user one tested page that leads from trial or sign-in to the right client download and enrollment receipt.

### Control center

The gateway already stores session history, work history, intent-plane records, agent runs, account connections, and bounded semantic telemetry. Android and browser expose parts of this data. No account-scoped product page combines active intents, switchboards, agents, runs, costs, and receipts.

## Stages

### Stage 1: quiet companion controls

Ship the two browser controls. Persist the local voice choice. Keep mute authority local. Test markup, copy selection, and playback suppression. Package the extension after verification.

### Stage 2: Android parity

Add the same two actions to the Android companion. Keep the native notification as background state and recovery. Prove immediate local TTS stop and copy of the final transcript on a device.

### Stage 3: one sign-in and enrollment path

Finish the hosted account authority already specified by `production-grade-hosted-product`. Link anonymous trial state into the account. Mint device-bound enrollment credentials for Android and browser. Remove manual token entry from the normal hosted path while keeping self-host setup available.

### Stage 4: public try and download path

Update the public copy. Add one Try Ag action for a bounded browser trial. Add Android and browser download actions with version, digest, install steps, and support status. Record acquisition and enrollment receipts without raw transcript content.

### Stage 5: companion control center

Build an account-scoped control center over existing gateway records. Show intents and switchboards first. Then show agents, runs, history, account connections, usage, and cost. Keep voice input available. Keep local action approval on the device that owns the action.

### Stage 6: speech completion

Add text-only phrase suggestions beside the companion. Suggestions must remain optional evidence. They may not enter the user's transcript or launch work unless the user accepts them. Audio interruption and echo handling remain a later measured slice.

## Safety checks

- Server output remains a proposal.
- Page content remains evidence.
- Muting changes local playback only. It does not cancel an agent run.
- Copy is an explicit local clipboard action.
- Telemetry uses allowlisted events and excludes transcript text, tokens, credentials, and page bodies.
