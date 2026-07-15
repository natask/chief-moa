# Tweeks-Inspired Page Runtime Decision

## Status

Proposed for user alignment on 2026-07-14. This document records the inspected
prior art and a clean-room Moa design. It does not authorize implementation or
copying third-party source.

## Intent

The browser agent should combine two outcomes:

1. It can do browser work through the existing observe, propose, locally
   validate, act, receipt, and observe-again loop.
2. It can change the current site for the user: hide or retain selected page
   content, install persistent per-site modifications, and place explanatory
   overlays directly on the page.

"Remove" has three materially different meanings and must not become one
untyped command:

- **Visually hide:** reversible and suitable for a persistent per-site rule.
- **Detach page DOM:** a fragile, page-local effect that is not durable across a
  reload and is out of the first slice.
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

### A. Clone a general userscript manager as the browser agent

Generated JavaScript would be the common representation for automation,
persistent modification, and overlays.

This is expressive, but it collapses model reasoning, privileged execution,
approval, persistence, and UI into opaque code. It also makes a simple
explanation overlay carry the same risk as arbitrary site automation.

### B. Keep only the current declarative CSS tweaks

Every modification would compile to packaged CSS, and overlays would remain an
extension-only special case.

This is safe and reversible but cannot add bounded interactive page features or
support the long tail of user-authored site modifications.

### C. Tiered page runtime (selected)

Use one page-observation and receipt boundary with three explicitly different
execution tiers:

| Tier | Purpose | Representation | Execution authority |
| --- | --- | --- | --- |
| A: packaged effects | Common reversible page changes and explanations | Validated typed records | Packaged content-script code only |
| B: bounded mutations | Fresh-anchor text edits and later narrowly approved DOM operations | Typed proposal with preconditions and undo | Local mutation broker after role/envelope/approval checks |
| C: user scripts | Long-tail user-created site features and automation | Inspectable versioned script artifact | Chrome `userScripts`, separately enabled and permissioned |

Tier C is not a fallback for model proposals that fail Tier A or B validation.
The user must explicitly choose to create/install a script, inspect its scope
and grants, and enable Chrome's user-script capability. Generated code never
runs in the extension service worker or packaged content-script context.

## Selected Architecture

### One observation core, separate effect owners

```text
content-script observation runtime
  -> snapshot + stable local element anchors + page/layout epochs
  -> gateway receives bounded evidence and proposes typed output
  -> extension proposal router separates:
       annotation -> page annotation renderer
       visual rule -> persistent page-effect store/compiler
       editable change -> mutation broker
       browser action -> existing browser action executor
       user script candidate -> inspect/approve/install workflow
  -> owning local runtime revalidates current page state
  -> effect/action is applied or rejected
  -> local receipt is stored and optionally synced to the gateway
```

Observation identity is shared; execution policy is not. An anchor may support
an explanation, a visual rule, or an action proposal, but each destination
applies its own allowlist and freshness rules.

### Packaged page effects

Replace the current ad hoc tweak record over time with a versioned
`moa.page-effect.v1` envelope. The first vocabulary remains deliberately small:

- `visibility.hide` / `visibility.show` for reversible visual removal;
- the existing font, color-theme, and width effects;
- `annotation.callout`, `annotation.highlight`, and `annotation.label` for
  explanatory overlays.

The model sends no CSS, HTML, JavaScript, event-handler names, or arbitrary
method names. Packaged extension code compiles known visual effects and renders
known annotation components.

Persistent visual effects are scoped by normalized URL match rules, not only
`location.origin`. Each record includes an id, schema version, name, scope,
effect kind and params, enabled state, provenance, created/updated revision, and
last apply receipt. The gateway owns the durable artifact and revision history;
the extension keeps an install/cache projection and remains the only page
executor.

### Explanatory overlays

Annotations are extension-owned UI, not page-authored DOM content. A packaged
content script creates one top-level host with an isolated shadow root. The
renderer uses fixed-position overlay chrome and locally remeasures its bound
anchor on scroll, resize, visual-viewport changes, and meaningful DOM changes.

Each annotation contains:

- annotation id and typed presentation;
- bounded text/content payload;
- tab, frame, snapshot, page epoch, and anchor id;
- placement preference and collision fallback;
- freshness state (`current`, `dirty`, `stale`, `unavailable`);
- optional dismissal and workspace-artifact references.

The overlay layer defaults to `pointer-events: none`; only packaged controls
opt back into pointer events. It must exclude itself from page observations and
automation selectors. When identity is stale, it disappears or renders a
detached stale notice in extension UI; it never snaps to a nearby lookalike.

Durable explanation text may survive in the gateway workspace. A live overlay
mount does not survive navigation or extension restart without a fresh local
observation and successful re-ground.

### Bounded mutation broker

The first Tier B operation remains `editable_text_change`, already specified by
this OpenSpec. It binds the before value/hash and proposed value to a fresh,
non-sensitive editable anchor and produces apply and undo receipts.

Persistent "remove this" should initially compile to `visibility.hide`, not
detach the node. Direct DOM insertion, arbitrary attributes, event handlers,
and component injection remain out of the first mutation vocabulary. Adding an
interactive page feature belongs in Tier C until a narrower typed primitive is
accepted.

### Explicit user-script lane

The long-tail lane may adopt Chrome's `userScripts` API behind an explicit
setting and onboarding check. Its artifact must include:

- user-visible name, purpose, source intent, full inspectable code, and version;
- URL matches/excludes and protected-host evaluation;
- requested grants/capabilities and execution world;
- run timing and frame scope;
- enabled state, install/update/rollback history, and code digest;
- generation provenance, user approval, local registration status, and runtime
  receipts/errors.

Default world is `USER_SCRIPT`, not `MAIN`. Main-world access is a distinct
high-risk grant with an explicit explanation. The first version should omit
remote `@require`, arbitrary network access, credential/cookie reads, and
extension-privileged messaging. Script updates use revision/hash
preconditions, retain the prior version for rollback, and re-register after an
extension update because Chrome clears registered user scripts on update.

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

Moa keeps the existing model-independent control loop:

```text
observe -> gateway proposes one typed action -> extension validates current
evidence + role + delegation envelope -> extension executes -> receipt -> observe
```

Automation should move from ephemeral element indexes to observation anchors
before broadening its action vocabulary. The default action executor must not
accept arbitrary `Runtime.evaluate` expressions. Any developer/debug evaluate
capability remains separate from end-user agent authority and cannot be
advertised as a normal browser tool.

## Ownership And State

| Component | Owns | Does not own |
| --- | --- | --- |
| Gateway | Page-effect/user-script artifacts, versions, source intent, agent runs, synced receipts | DOM execution, browser permissions, live anchors |
| Extension background | Tab/session coordination, proposal routing, installed artifact projection, user-script registration | Canonical artifact history, model/provider keys |
| Observation runtime | Epochs, anchor registry, geometry, freshness | Durable cross-device state |
| Annotation renderer | Shadow-root overlay DOM and placement | Conversation/artifact authority |
| Mutation broker | Local precondition checks, apply/undo, receipts | New action classes from model prose |
| Browser action executor | Allowlisted page/tab actions under agent/envelope policy | Persistent site customization |

## Failure And Recovery

- A stale anchor rejects mutation/action and unmounts or stales its annotation.
- A bad effect record preserves the last-good installed revision.
- A page-effect apply failure records an error without disabling unrelated
  effects for that site.
- A user script that exceeds mutation/error budgets is quarantined locally and
  requires explicit re-enable; quarantine is not reported as uninstall.
- A gateway outage preserves last-good installed visual effects and workspace
  artifacts but starts no new delegated actions or script installations.
- Extension restart reconstructs installed effect/script projections from the
  gateway/local cache, but live anchors and annotations require re-observation.
- Protected pages, browser-internal URLs, password fields, cross-origin frames,
  and ambiguous shadow-DOM targets fail visibly with no claimed success.

## Smallest Coherent Implementation Order

1. Finish the observation-anchor primitive and use anchors in the existing
   browser action loop.
2. Add packaged anchored callout/highlight overlays with scroll/replacement
   smoke coverage.
3. Generalize current tweaks into versioned persistent visual page effects,
   preserving enable/disable/remove and reload behavior.
4. Add `editable_text_change` apply/undo through the local mutation broker.
5. Unify effect, mutation, and action receipts in the workspace review history.
6. Only then add the separately opt-in `userScripts` artifact/install lane with
   protected-host, grants, rollback, and quarantine tests.

Each item remains its own acceptance unit. Tier C does not block the safe
mutation and overlay outcomes requested here.

## Alignment Questions

1. Is the selected tiered runtime the intended meaning of "clone Tweeks": match
   its user outcome and lifecycle while preserving Moa's stricter execution
   boundary, rather than copying its source or making generated scripts the
   default browser-agent action format?
2. For the first release, should "remove this" mean reversible persistent hide
   only, with actual site-data deletion staying in the separately approved
   browser-action path?
