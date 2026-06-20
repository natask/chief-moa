# Moa Mobile Boundaries

This is the product shape for the Android-first build.

Moa has a mobile interface, a remote execution engine, and multiple action channels. The boundaries must stay explicit so the system is powerful without becoming sloppy or unsafe.

## Boundary Summary

```text
Mobile app
  Owns: user interface, overlay, voice, screen context, permissions, approvals, phone-local execution.

Execution machine
  Owns: model access, long-running agents, desktop/server/API work, heavy reasoning, memory sync.

Self-hosted gateway
  Owns: authenticated bridge between mobile and execution machine.

External APIs
  Own: direct integrations such as calendar, email, CRM, docs, repo hosts, payments, etc.
```

The mobile app is the user's interface. The execution machine is the worker. The phone remains the authority for phone-local actions.

## Input Surfaces

Moa should support three input surfaces:

1. **Overlay**
   - Always-available small control on top of the current app.
   - Good for quick capture, voice, short commands, and "what am I looking at?"
   - Should not become the whole product UI.

2. **Full Moa App**
   - The deep work surface.
   - Used for plans, action history, approvals, settings, memory, app connections, and inspecting long-running tasks.
   - This is where users should feel they can delve in.

3. **System Events**
   - Notifications, share sheet, intents, quick settings tile, explicit voice button, scheduled tasks.
   - Good for "catch it right there" workflows.
   - Must route through the same action policy as manual commands.

## Execution Surfaces

Moa has four execution paths:

1. **Phone-local UI Actions**
   - Accessibility screen read.
   - Tap visible UI.
   - Back/home/scroll.
   - Open apps or deep links.
   - These run on the phone only.

2. **Phone-local Android APIs**
   - SMS, contacts, calendar, notifications, microphone, camera, files, location.
   - These run on the phone through Android permissions.
   - Sensitive actions require local approval.

3. **Remote Machine Actions**
   - Model calls.
   - Desktop/browser automation.
   - Code agents.
   - Long-running research or build tasks.
   - These run on the user's machine behind the self-hosted gateway.

4. **External API Integrations**
   - Gmail, Calendar, Slack, GitHub, Notion, banking, cloud services, etc.
   - These should use official APIs when possible.
   - OAuth/API tokens live on the execution machine or server, not in the overlay layer.

## Authentication Boundary

Authentication has two layers:

1. **Mobile User Session**
   - The user logs into Moa on the phone.
   - This identifies the user and device.
   - It controls profile, settings, permissions, and device registration.

2. **Execution Engine Credentials**
   - Model provider keys and integration tokens stay on the self-hosted execution machine.
   - The phone gets a scoped Moa gateway token, not raw OpenAI/Anthropic/Gemini/API keys.
   - If the phone is compromised, provider credentials should not be recoverable from the APK or app storage.

The gateway authenticates the phone. The phone authenticates the user. The phone still approves phone-local actions.

## Command Flow

```text
User speaks/types/taps overlay
  -> mobile captures text + optional screen context
  -> request goes to local broker
  -> broker decides local-only vs remote reasoning
  -> remote engine returns answer or action proposal
  -> mobile policy engine validates proposal
  -> approval UI if needed
  -> action executes on correct surface
  -> receipt is recorded
```

The remote engine should return structured proposals, not hidden imperative commands.

## Interaction Modes

### Ambient Mode

The overlay is present while the user uses other apps.

Use for:

- "What is this screen?"
- "Summarize this."
- "Tap Allow."
- "Reply to this message."
- "Remember this."
- "Send this to my machine."

### Focused Mode

The full Moa app is open.

Use for:

- Reviewing a plan.
- Managing connected accounts.
- Inspecting action logs.
- Editing memory.
- Running long tasks.
- Choosing between options.

### App-Switching Mode

Moa intentionally opens another app or deep link.

Use for:

- A task must happen in another app's UI.
- The user expects to watch or guide the action.
- Accessibility will act on visible controls.

This mode must remain visible. If the user must trust Moa to operate another app, the current app and intended action should be clear.

## Action Policy

Moa needs a single policy engine across all surfaces.

```text
read context       -> allowed after permission
draft              -> allowed
tap/navigation     -> explicit command or confirm
send/share/submit  -> confirm
money/security     -> block or step-up auth
```

Examples:

- "Summarize this screen" can auto-run.
- "Tap Continue" can run if explicitly requested.
- "Send this SMS" requires confirmation.
- "Pay this invoice" is blocked until there is a hardened payment policy.

## What Lives Where

| Capability | Mobile App | Execution Machine |
| --- | --- | --- |
| Overlay UI | Yes | No |
| Voice capture | Yes | Optional processing |
| Screen read/tap | Yes | No direct authority |
| Android permissions | Yes | No |
| Model provider keys | No | Yes |
| Long-running agents | No | Yes |
| OAuth/API integrations | Usually no | Yes |
| Approval UI | Yes | No |
| Action receipts | Canonical local copy | Synced copy |

## Product Implication

The overlay makes Moa easy to summon. The full app makes Moa inspectable and trustworthy. The execution machine gives Moa power. API integrations give Moa reliability.

Do not collapse these into one blob. The boundaries are the product.
