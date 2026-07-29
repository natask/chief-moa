# Design

## Product and authority boundary

`Ag.app` and the browser extension are peers, not shells around one another.

| Concern | Mac product | Gateway bridge | Browser product |
| --- | --- | --- | --- |
| Product identity | Mac bundle/device identity | Authenticated account and request identities | Extension install/device identity |
| Primary UI | Native menu-bar summon and Mac control surfaces | None | Browser companion and browser workspace |
| Local context | Explicitly granted macOS AX/screen context | Stores only bounded released evidence | Explicit page/tab evidence |
| Permissions | Microphone, AX, optional screen capture | No platform permission | Chrome extension, tab, debugger, microphone |
| Delegation | Creates/cancels a bounded request | Persists, targets, queues, and projects status | Claims, validates, approves, executes, receipts |
| Execution | macOS-local actions only | Never executes local effects | Browser-local actions only |

Neither product inherits authority from account sign-in, a shared conversation,
device presence, or the other product's grant. The Mac app never receives
cookies, authorization headers, browser storage, raw CDP access, or extension
permissions. The extension never receives AX objects, Mac screen-capture
permission, or authority to type into native applications.

## Identity and presence

Both products register independently through the existing authenticated
device-client contract. A browser candidate is eligible only when its heartbeat
is fresh and its manifest advertises the exact requested browser tool/profile.

The bridge envelope binds:

```text
request_id / idempotency_key
account_id / session_id / conversation_id (when present)
source_surface = macos
source_device_id
target_surface = browser
target_device_id
intent_id / run_id (when present)
confirmed_at / confirmation_subject
tool_or_profile
bounded_arguments + argument_digest
scope: origins, tabs/documents, action classes
approval_class
created_at / expires_at
```

The stable `request_id` is the cross-product display and recovery identity.
Repeated submission with the same idempotency key returns the existing request.
A different target, arguments, digest, scope, or expiry creates a new request
and requires a new explicit delegation decision.

## Explicit delegation

Ordinary Mac chat does not imply browser delegation. The Mac product must show
the target browser and bounded requested outcome before submission. An explicit
user instruction that already names browser execution can satisfy this
delegation confirmation; the product must not add a redundant generic prompt.
Inferred browser routing requires confirmation before the request is queued.

V1 uses a specific selected browser device. The gateway may rank compatible
candidates for presentation, but it cannot silently retarget an accepted
request. Changing the target requires a new confirmation-bound request.

The request is a proposal, not a command. Claiming it grants no more authority
than the intersection of its envelope, the extension manifest, current browser
state, the active browser delegation profile, Chrome permissions, and local
policy.

## Approval and execution

The browser extension owns approval classification and the final pre-effect
check. Safe tab opening may execute under an already confirmed compatible
browser delegation. Publishing, submitting, purchasing, sending, credential
entry, raw CDP, or other sensitive effects require the browser product's normal
approval checkpoints even when the request originated on the Mac.

Immediately before each effect, the extension revalidates target device,
expiry, origin/tab/document scope, observation freshness when relevant,
argument digest, cancellation state, and local capability. A failure produces a
reason-coded terminal or blocked receipt and no effect.

macOS Accessibility is not a fallback browser executor. If the extension cannot
perform the request, the Mac product reports that state and offers an explicit
next choice; it does not click Chrome through AX behind the user's back.

## Progress and receipts

The gateway holds the canonical request lifecycle:

```text
queued -> claimed -> validating -> awaiting_approval -> executing
       -> succeeded | failed | declined | cancelled | expired
```

Transitions are monotonic and idempotent. The extension posts bounded progress
events and a terminal receipt bound to the request, target device, arguments
digest, outcome, timestamps, and any safe result reference. Raw page content,
cookies, credentials, and browser storage are excluded from progress and
receipts.

Both products may read this same projection. They do not synchronize transient
UI state, microphone ownership, panel position, drafts, or visual components.

Cancellation is gateway-recorded and monotonic. The Mac can request
cancellation because it originated the delegation. The extension observes it
before new effects and stops safely; cancellation does not claim reversal of an
effect already receipted as complete.

## Disconnected behavior

- No compatible extension: do not queue an unbound side effect. Show that the
  browser product must be installed, connected, and selected.
- Known target offline/stale: retain a targeted `queued` or `blocked_offline`
  request only until its bounded expiry. Show that state on the Mac.
- Target disconnects after claim: stop before new effects, retain the same
  target, and move to a reason-coded blocked, failed, or expired state.
- Gateway disconnects before claim: the extension performs nothing.
- Gateway disconnects during execution: the extension stops before another
  effect when it cannot renew/revalidate its lease. It reconciles an already
  completed effect by idempotent receipt after reconnect.
- Duplicate delivery/reconnect: request identity and terminal receipt state
  prevent repeating an effect.

## First vertical slice

The first implementation uses the existing safe `browser.tab.open` tool with a
single validated HTTPS URL. It proves the complete product relationship without
claiming multi-step browser-agent parity:

1. Mac discovers one fresh compatible browser device.
2. User explicitly delegates opening the URL to that named browser.
3. Gateway creates one target-bound request.
4. Extension claims it, revalidates HTTPS input and local capability, and opens
   one tab.
5. Extension posts one terminal receipt.
6. Mac and browser display the same request outcome in product-native UI.

The slice must also prove no-extension, offline-before-claim, disconnect-after-
claim, cancellation, duplicate delivery, wrong-device claim, expired request,
and invalid/non-HTTPS URL behavior.
