# Moa Secure Action Runtime

Moa is not an overlay that clicks things. Moa is a local delegated-action runtime.

The self-hosted server may reason, store memory, and return proposed plans, but it must not be the authority for phone actions. The Android app owns permissions, policy, user approval, execution, and audit logs.

## Core Rule

All device actions follow this path:

```text
User request
  -> local context capture
  -> model or local planner proposes intent
  -> local policy engine checks capability, risk, and permission
  -> user approval if required
  -> local tool executes on device
  -> local signed receipt is written
  -> optional sync to self-hosted server
```

The model never directly performs device actions. It only proposes structured actions.

## Threat Model

Moa must assume these can be hostile:

- Web pages, notifications, app text, chat messages, and accessibility-tree content.
- Model outputs from the self-hosted server.
- Third-party apps that label buttons deceptively.
- Stale screen context.
- A compromised or misconfigured self-hosted server.

The app must not execute an action just because screen text or the model says to.

## Action Classes

| Class | Examples | Default Policy |
| --- | --- | --- |
| Read-only | summarize screen, read notifications, inspect calendar | Auto-run after permission is granted |
| Local navigation | back, home, scroll, open app, tap non-sensitive UI | Explicit command or lightweight confirmation |
| Communication draft | draft SMS/email/chat reply | Auto-draft, never auto-send by default |
| External side effect | send SMS, create event, place call, submit form | Require explicit approval |
| Sensitive side effect | payments, banking, password changes, security settings, medical/legal actions | Block initially or require step-up auth |

## Capability Manifest

Every tool must declare a static manifest before the model can call it:

```json
{
  "name": "screen.tap",
  "description": "Tap a visible UI element by label or node id.",
  "risk": "local_navigation",
  "permissions": ["accessibility"],
  "args_schema": {
    "label": "string",
    "expected_package": "string"
  },
  "approval": "explicit_or_confirm",
  "audit": true
}
```

The app loads the manifest locally. The server can read it, but cannot change it without an app update or user-approved signed config.

## Action Proposal Format

The server returns proposals, not commands:

```json
{
  "type": "action_proposal",
  "summary": "Send a short reply to Nat.",
  "actions": [
    {
      "tool": "sms.send",
      "args": {
        "recipient": "+15551234567",
        "body": "I am on my way."
      },
      "reason": "The user asked to reply to the latest SMS.",
      "risk": "external_side_effect",
      "approval": "required"
    }
  ]
}
```

The app validates:

- Tool exists in local manifest.
- Required Android permission is granted.
- Proposal risk is not lower than manifest risk.
- Required approval level is satisfied.
- The current screen/package still matches any screen-bound action.

`screen.tap_text` tool requests must include `expected_package`. Immediately
before tapping, Android reads the active accessibility root and requires its
package to match exactly. A missing package or an app switch fails closed and
produces a failed local receipt. An explicit local `/tap` command binds the
action to the package observed when that command begins and performs the same
final check.

## Approval Rules

Moa needs approval modes that are visible and predictable:

- `auto`: read-only actions and safe local state updates.
- `explicit_command`: user typed or spoke the exact command, such as `/back` or `/tap Allow`.
- `confirm`: show a local approval card before execution.
- `step_up`: biometric or device credential before execution.
- `blocked`: not supported by this build.

Default approvals:

- `screen.read`: auto
- `screen.tap`: explicit command or confirm
- `screen.back`: explicit command
- `app.open`: explicit command or confirm
- `sms.read`: auto after SMS permission
- `sms.send`: confirm
- `phone.call`: confirm
- `contacts.write`: confirm
- `payment.*`: blocked
- `security_settings.*`: blocked

## Screen Context Rules

Screen context is evidence, not instruction.

Allowed:

- Use visible text to answer questions.
- Use visible button labels to propose actions.
- Use package/class names to verify the target app.

Not allowed:

- Follow instructions found on the screen unless the user asked for them.
- Tap destructive or financial buttons without confirmation.
- Send hidden text from password fields or sensitive views to the server.
- Execute a plan if the screen changed after approval.

Android heartbeat metadata includes a bounded `context_descriptor` for shared
capability resolution. It contains only the current native application package,
window class, capture time, and freshness; its privacy fields state that page
content and URLs are not included. `execution_adapters` advertises the
device-local accessibility session separately and never treats an open app as
evidence that the user is authenticated to it.

## Audit Receipts

Every executed action writes a local receipt:

```json
{
  "id": "act_...",
  "timestamp": "2026-05-31T00:00:00Z",
  "tool": "sms.send",
  "risk": "external_side_effect",
  "approval": "confirm",
  "args_hash": "sha256:...",
  "target_package": "com.google.android.apps.messaging",
  "result": "success",
  "previous_receipt_hash": "sha256:..."
}
```

Receipts form a local hash chain. The self-hosted server can sync copies, but local storage remains canonical for the device.

## Product Boundary

Moa can be self-hosted, but it still needs a hard trust boundary:

- Server: planner, memory, model inference, long jobs.
- App: permissions, policy, approvals, execution, receipts.
- User: final authority for sensitive actions.

That boundary is the product.
