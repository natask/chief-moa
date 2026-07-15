# Tweeks-Inspired Page Runtime Decision

## Status

Accepted direction, corrected by the user on 2026-07-14. Generated userscripts
and arbitrary page evaluation are primary browser-agent capabilities. Chrome
Web Store eligibility is not a product constraint for the Quorum-owned runtime.
This remains a clean-room design and does not authorize copying third-party
source.

## Intent

The browser agent should combine two outcomes:

1. It can do browser work through the existing observe, propose, locally
   validate, act, receipt, and observe-again loop.
2. It can change the current site for the user: hide or retain selected page
   content, install persistent per-site modifications, and place explanatory
   overlays directly on the page.

"Remove" still has three materially different outcomes that receipts and undo
need to distinguish, but all three may be implemented by generated code:

- **Visually hide:** reversible and suitable for a persistent per-site rule.
- **Detach page DOM:** a page-local effect which can be performed immediately
  and made persistent by installing a userscript that repeats it.
- **Delete application data:** a real site action (for example deleting a task)
  that stays in the browser-action approval and receipt path, never the visual
  modification path.

## Prior Art Inspected

The locally installed Tweeks 0.0.7.20 Chrome package was inspected read-only.
It is useful behavioral prior art, but the package contains no license granting
Moa permission to copy its implementation. Moa will reproduce selected product
behaviors through its own contracts and code.

The useful shape is:

- persistent site-specific userscript records with separate metadata and code;
- enable, disable, update, remove, import, export, and follow-up modification;
- URL match/exclude rules and protected-host policy;
- execution timing (`document-start`, body, end, idle, or explicit menu action);
- dynamic Chrome `userScripts` registration and world configuration;
- an element picker that records selectors, shadow-root path, interaction
  hints, and observation-time rectangle;
- a browser automation facade with typed navigation, click, fill, query,
  snapshot, wait, and screenshot operations;
- optional capability grants, script-specific storage, runtime messaging, and
  mutation-runaway protection.

The current Moa extension already owns complementary pieces:

- `tweaks.js` stores reversible per-origin declarative CSS records and reapplies
  them at page load;
- `background-browser-automation-runtime.js` runs the bounded background
  observe/step/act loop and gateway-queued browser tools;
- `content.js` captures page evidence and executes packaged click/type/select/
  scroll/key actions;
- the browser-situated-agent change defines observation anchors, the on-page
  annotation layer, workspace, delegation envelope, and local receipts.

## Considered Shapes

### A. Declarative-only page runtime

Every modification would compile from a packaged vocabulary, and overlays
would remain an extension-only special case.

This is easy to validate but prevents the agent from creating the site-specific
features, repairs, overlays, and automations that motivate the product.

### B. Userscripts only, including extension control UI

Generated JavaScript would implement automation, persistent modification,
explanations, and all browser-agent controls.

This is maximally expressive, but a broken page script could remove the user's
stop/review controls along with the page it is modifying. Canonical task state
and the emergency control surface should not depend on generated page code.

### C. Userscript-native page runtime with a packaged control plane (selected)

Generated JavaScript is the general page-action and page-modification language.
Packaged typed actions/effects remain shortcuts for common operations, not an
authority ceiling or mandatory intermediate representation.

| Lane | Purpose | Representation | Execution authority |
| --- | --- | --- | --- |
| Immediate evaluation | Inspect, modify, automate, or mount a transient overlay now | Generated JavaScript plus target tab/frame/world | Chrome `userScripts.execute` where available |
| Persistent userscript | Reapply a modification or feature on matching pages | Versioned inspectable JavaScript artifact plus match/run metadata | Chrome `userScripts.register` |
| Packaged helpers | Fast common click/fill/snapshot/tweak/annotation operations | Existing typed records | Packaged extension code |
| Packaged control plane | Stop, script review, rollback, task status, approvals, and receipts | Extension-owned UI and gateway records | Never delegated to page-generated code |

The user-script permission/toggle is enabled as part of installing the private
runtime. Per-script manual review is available but not required when the user
has already delegated a task whose envelope authorizes evaluation or persistent
site modification. Generated code never executes in the extension service
worker itself.

## Selected Architecture

### One observation core, separate effect owners

```text
content-script observation runtime
  -> snapshot + stable local element anchors + page/layout epochs
  -> gateway model produces an action, generated script, or script revision
  -> extension binds it to the selected agent + task/delegation authority
  -> execution router chooses:
       immediate script -> chrome.userScripts.execute
       persistent script -> version/store + chrome.userScripts.register
       packaged helper -> existing content/CDP action runtime
  -> the browser executes in USER_SCRIPT or MAIN as requested
  -> local receipt is stored and optionally synced to the gateway
```

Observation anchors improve generated code prompts and post-execution evidence,
but generated code is not limited to anchor-addressable operations. It may
query the live DOM, use site-specific selectors, observe future mutations,
mount page UI, and interact with page JavaScript when running in `MAIN`.

### Script artifact and execution contract

One generated-script shape supports both immediate and persistent execution:

- script id, name, purpose, full source, source digest, and version;
- source turn, agent role, task/run, and delegation-envelope references;
- target tab/document/frame or persistent URL matches/excludes;
- execution mode (`immediate`, `persistent`, or both);
- execution world (`USER_SCRIPT` or `MAIN`) and run timing;
- requested extension bridge capabilities, if any;
- install/enabled state, prior revision, and rollback pointer;
- execution result, console/error summary, and before/after evidence refs.

The gateway owns the durable artifact and version history. The extension owns
browser registration, execution, local stop, and receipts. Code is inspectable
before and after execution, but an authorized Delegate run does not require a
separate confirmation for every generated revision unless its envelope declares
a checkpoint.

Chrome 135+ provides `chrome.userScripts.execute` for immediate code injection
and `chrome.userScripts.register` for persistent match-based scripts. The
runtime should feature-detect immediate execution and report a clear platform
blocker on older Chromium rather than silently changing semantics.

### Explanatory overlays

Generated userscripts may create arbitrary page overlays: callouts, highlights,
labels, controls, inspectors, or site-specific widgets. They may use a shadow
root when CSS isolation is useful and may install mutation/resize/scroll
observers to keep themselves aligned. Persistent overlays are ordinary
registered userscripts; transient explanations use immediate evaluation.

Moa still provides a packaged overlay helper because it gives the model a quick
way to mount a grounded explanation without generating boilerplate. Its receipt
contains:

- annotation id and typed presentation;
- bounded text/content payload;
- tab, frame, snapshot, page epoch, and anchor id;
- placement preference and collision fallback;
- freshness state (`current`, `dirty`, `stale`, `unavailable`);
- optional dismissal and workspace-artifact references.

Generated overlays are not required to use this helper or its presentation
constraints. The packaged browser control plane must nevertheless exclude its
own stop/review UI from page observations and generated-script cleanup.

Durable explanation text may survive in the gateway workspace. A live overlay
mount does not survive navigation or extension restart without a fresh local
observation and successful re-ground.

### Arbitrary mutation and evaluation

The browser agent may evaluate arbitrary JavaScript and may use it to insert,
replace, detach, restyle, instrument, or persist page behavior. It is not
restricted to `editable_text_change` or a packaged mutation vocabulary.

The runtime records what code ran and its observable result; it does not claim
that arbitrary code is automatically reversible. When the requested outcome
is expected to persist, the agent should normally create a versioned registered
userscript. When practical, generated scripts should expose their own cleanup
function or pair with an inverse revision, but lack of a perfect inverse does
not block execution if the delegated task permits the effect.

### Execution worlds and extension capabilities

`USER_SCRIPT` is useful when DOM access is enough and separation from site
globals avoids accidental collisions. `MAIN` is first-class when the script
needs page-defined JavaScript state or APIs. Main-world execution is recorded,
not prohibited or treated as an exceptional developer-only path.

Extension-privileged APIs remain behind a small message bridge so page code does
not automatically inherit service-worker authority. That bridge can be broad
and extensible, but every exposed capability has a named handler and receipts.
This is a technical context boundary, not a Chrome Web Store policy concession.
Script updates use revision/hash preconditions and retain prior versions. The
extension re-registers enabled scripts after an extension update because Chrome
clears dynamic user-script registrations during updates.

Here, **arbitrary evaluation** means accepting a caller-provided JavaScript
string and executing it, rather than selecting a packaged typed operation. It
is not categorically forbidden: it is the defining capability of the explicit
user-script lane. It is forbidden as an ordinary model-proposed browser action
because the local broker cannot infer complete effects, reversibility, or
authority from an opaque program.

`MAIN`-world execution shares the website's JavaScript environment and can use
page-defined globals; the page can also observe or interfere with that code.
`USER_SCRIPT`/isolated execution still shares the DOM but separates JavaScript
globals. "Broad main-world execution" means combining `MAIN` with wide URL or
frame scope and caller-provided code. Moa treats those as independent grants:
site scope, frame scope, arbitrary-code authority, and execution world must each
be visible and explicitly allowed.

### Browser automation

Moa extends the existing loop rather than replacing it:

```text
observe -> gateway proposes an action or generated script -> extension checks
selected-agent/task authority -> extension executes -> receipt -> observe
```

Arbitrary `evaluate` is a normal browser-agent capability. Prefer
`chrome.userScripts.execute` because it is expressly designed for user-provided
code and returns per-frame results. CDP `Runtime.evaluate` remains useful when
the debugger executor is already attached or page-world behavior requires it.
Packaged click/fill/query/snapshot actions remain available because they are
cheaper for the model and easier to receipt, not because generated code is
forbidden.

## Ownership And State

| Component | Owns | Does not own |
| --- | --- | --- |
| Gateway | User-script artifacts, versions, source intent, agent runs, synced receipts | DOM execution, browser permissions, live anchors |
| Extension background | Tab/session coordination, script execution/registration, installed artifact projection, stop, local receipts | Canonical artifact history, model/provider keys |
| Observation runtime | Epochs, anchor registry, geometry, freshness | Durable cross-device state |
| Generated userscript | Arbitrary page inspection, mutation, automation, and overlays in its selected world | Extension service-worker authority unless explicitly bridged |
| Packaged control UI | Script inspection, enable/disable, rollback, stop, task status | Page behavior and canonical state |

## Failure And Recovery

- A stale anchor is reported to generated code and receipts; scripts may
  re-query/re-ground rather than being categorically rejected.
- A failed script revision preserves the prior installed revision for manual or
  agent-driven rollback.
- Stop prevents new agent-triggered evaluations and unregisters or disables
  scripts selected by the user; it cannot retroactively undo arbitrary page
  effects that supplied no cleanup path.
- A gateway outage preserves last-good installed visual effects and workspace
  artifacts; already registered local scripts may continue to run.
- Extension restart reconstructs installed effect/script projections from the
  gateway/local cache, but live anchors and annotations require re-observation.
- Browser-internal pages and unavailable cross-origin frames report platform
  limits honestly. Quorum policy may choose where host access is enabled.

## Smallest Coherent Implementation Order

1. Add and verify the `userScripts` permission/onboarding plus an injected
   runtime adapter for `execute`, register, update, unregister, and restore.
2. Add the gateway-owned versioned script artifact and extension install/cache
   projection with code digests and rollback.
3. Expose immediate `evaluate` and persistent-script creation to the selected
   browser agent and delegation envelope.
4. Add script result/error/console receipts and before/after page evidence.
5. Add generated overlay and persistent-remove fixtures, including `MAIN` and
   `USER_SCRIPT` execution.
6. Add packaged inspect, enable/disable, rollback, and stop controls that remain
   reachable when a generated page script breaks its own UI.
7. Move existing typed tweaks and browser actions behind the same script/task
   history as convenience operations without making them mandatory.

Each item remains its own acceptance unit. Chrome Web Store publication is not
a release gate for this runtime; verification targets the private unpacked or
otherwise Quorum-controlled installation path.
