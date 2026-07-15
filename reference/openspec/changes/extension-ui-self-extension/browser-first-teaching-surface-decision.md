# Browser-First Teaching Surface: Research And Proposed Decision

## Status

Superseded as the primary product proposal on 2026-07-14 by
`reference/openspec/changes/browser-situated-agent-experience`. The research,
browser feasibility evidence, and teaching-loop design remain useful, but the
user clarified that tutorials are one use case rather than the product
architecture. This note does not authorize browser implementation, extension
permission changes, provider spend, recording, packaging, or deployment.

## Intent Resolution

Primary intent: make the browser the first excellent, broadly available Chief
Moa surface—one that understands the changing work in front of the user,
teaches while the user acts, and can create useful visual artifacts rather than
only returning chat text.

Supporting intents and constraints:

1. The gateway and user data remain self-hostable and user-owned.
2. The product should work for people without a Mac; the web app or browser
   extension should be the primary distribution surface.
3. The assistant should explain the user's current work and teach by pointing,
   waiting, verifying, and adapting instead of sending the user to a video.
4. The current page is dynamic. Perception must track meaningful state changes
   instead of treating one screenshot as durable truth.
5. Generated tables, diagrams, process chains, canvases, and other artifacts
   should become first-class, editable outputs.
6. Browser content and model output remain evidence/proposals, not privileged
   execution authority.

## What “Clicky” Refers To

The research surfaced several related but distinct products:

- The original [Clicky](https://github.com/farzaa/clicky) is an MIT-licensed
  macOS tutor. It captures the screen on an explicit voice turn, speaks, and
  points at pixels. Its public repository includes a self-deployed Cloudflare
  Worker holding provider credentials, but its author states that newer work is
  private.
- The separate [Clicky Chrome extension](https://clicky-ai.com/) uses
  push-to-talk, a visible-tab screenshot, and a compact interactive-node list.
  It points to DOM elements with selectors so the halo survives layout change.
  It uses `activeTab`, session-only memory, and a managed Fleece AI Cloudflare
  backend; it is not presented as a self-hosted gateway product.
- [Clicky for Windows](https://clicky.foo/) adds an explicit lesson-recording
  mode that outputs MP4 plus a Markdown transcript, alongside screenshots, OCR,
  annotations, and step-by-step tutoring.
- [OpenClicky](https://github.com/jasonkneen/openclicky) is an MIT-licensed
  macOS expansion with screen-aware guidance, image galleries, local agent
  work, artifacts, and computer-use fallback. It still targets macOS rather
  than broad browser distribution.
- [OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) is a
  separate MIT-licensed generative-interface project. It creates tables,
  charts, flowcharts, network diagrams, simulations, mockups, and other live
  HTML/SVG content inside sandboxed iframes. This likely accounts for the
  remembered table/chain/graph behavior.

The closest formulation of the desired Chief Moa product is therefore not a
clone of one project. It combines Clicky's in-context teaching loop with
OpenGenerativeUI's artifact fluency, under Chief Moa's self-hosted gateway and
proposal/approval/receipt boundary.

## Browser Feasibility

Official browser APIs support the required first product:

- Chrome's `sidePanel` API provides a persistent extension-owned surface beside
  the changing page and can remain open while the user changes tabs.
- `tabs.captureVisibleTab()` provides on-demand screenshots, but Chrome caps it
  at two calls per second and describes it as expensive; it is evidence capture,
  not a video pipeline.
- `tabCapture` provides an audio/video `MediaStream` for the active tab after a
  user invokes the extension. Capture can persist across page navigation and is
  suitable for explicit lesson recording.
- `MutationObserver` can report DOM-tree and attribute changes. It should be
  treated as a dirty signal followed by a bounded semantic resnapshot, not as a
  stream of raw mutations to the model.
- Figma's official APIs expose file/node structure, and its MCP server can read
  design context and write native Figma content. A Figma adapter can therefore
  provide better structure than screenshots alone when the user explicitly
  connects it.

Browser limits remain honest:

- DOM observation does not explain pixels inside canvas/WebGL, cross-origin
  frames, native dialogs, browser chrome, or desktop applications.
- Tab capture records only the tab and requires a user gesture; it is not an
  ambient whole-computer recorder.
- Figma in the browser is visually accessible, but much of its canvas is not a
  normal interactive DOM tree. Screenshots/frame samples plus an explicit Figma
  API/MCP adapter are a stronger combination.
- A screenshot, a video frame, and a DOM/API observation are independent
  evidence sources and may disagree. The system must retain provenance and
  freshness rather than merging them into invented certainty.

## Current Chief Moa Fit

The repository already implements much of the platform seam:

- `browser_extension/extension/manifest.json` already declares MV3,
  `activeTab`, `offscreen`, and `sidePanel`, and points at `sidepanel.html`.
- `sidepanel.html` already calls itself A.G.'s own persistent surface.
- `background.js` already captures visible-tab JPEG evidence and has a bounded
  CDP screenshot fallback.
- `content.js` already owns on-page perception, voice/text interaction, page
  description, structured interactive-element snapshots, and local action
  execution.
- `gateway/lib/ui-spec.js` and `ui-spec-runtime.js` already implement a
  declarative Tier A vocabulary (`card`, `list`, `stat`, and schematic `map`).
- `browser-generated-surface-contract.md` already defines a strong Tier B
  sandbox boundary for richer generated UI and keeps Tier C page-acting code in
  a separate explicit opt-in path.
- The gateway already owns provider credentials, durable conversation/work
  state, run records, generated artifacts, and self-host deployment.

The gap is not “add a browser.” It is to promote the existing browser pieces
into one coherent teaching-and-artifact product, add page-state epochs and
lesson progression, and finish the richer sandboxed surface.

## Considered Product Shapes

### A. On-page buddy only

Keep the assistant as a cursor/orb, speech, and highlight layer embedded in
every page.

This is excellent for immediacy and pointing, but too small for durable lessons,
generated tables/diagrams, comparison, history, and artifact editing. It repeats
the Android overlay problem if asked to carry the entire product.

### B. Extension-owned browser workspace (recommended)

Use three coordinated browser layers:

1. **On-page guide:** tiny voice trigger, halo/arrow, one current instruction,
   approval, and immediate feedback.
2. **Persistent side panel:** lesson plan, explanation, progress, questions,
   evidence/source view, compact generated components, and run/action status.
3. **Artifact tab/canvas:** large editable tables, diagrams, process chains,
   simulations, reports, and lesson recordings opened from the side panel.

The packaged extension owns capture, page anchoring, permissions, and local
action checks. The configured self-hosted gateway owns reasoning, durable
state, artifacts, models, and agent work. This reaches Chrome/Chromium users on
Windows, macOS, Linux, and ChromeOS without maintaining a browser fork.

### C. Chief Moa browser fork

Fork Chromium and make Chief Moa the browser shell.

This offers maximal browser UI integration but creates an enormous security,
update, distribution, and maintenance obligation before the teaching wedge is
proven. It should be reconsidered only if extension platform limits block a
validated, repeatedly used workflow.

## Proposed Decision

Select Option B. Treat the browser extension as a first-class Chief Moa product
surface, while retaining a thin-client authority model. “Thin” means it does
not own provider routing or canonical memory; it does not mean the UI must be
small or generic.

The 2026-07-14 product-direction refinement makes the platform order explicit:

1. **Browser first:** the open-source extension-owned experience is the primary
   product and the place where interaction quality is proven.
2. **Mobile companion:** Android supplies voice entry, notifications,
   approvals, status, and continuation when the user is away from the browser;
   it does not need to reproduce the full artifact workspace.
3. **Optional desktop browser shell:** a packaged Chromium/Electron experience
   may later provide tighter integration, but it consumes the same browser
   surface contracts rather than becoming a separate product architecture.
4. **Other native desktop surfaces later:** macOS-specific cursor companions
   are adapters only if demand justifies them, not the initial distribution
   strategy.

Open source is part of the product contract rather than only a repository
setting. A user must be able to inspect the capture, grounding, lesson,
renderer, action-policy, and gateway boundaries; self-host their durable state
and models; modify the companion; and understand which optional providers or
hosted services remain external.

The product wedge is:

> Learn any browser-based tool by doing the real task, with a voice guide that
> sees the current state, points at the next step, waits for the page to change,
> verifies progress, and can open an editable visual artifact when explanation
> needs more than words.

Figma-in-browser is the first demanding design partner, not a Figma-only
architecture. It exercises canvas-heavy perception, selection/context adapters,
multi-step teaching, visual explanation, and artifact generation.

The intended position next to projects such as
[OpenClaw](https://github.com/openclaw/openclaw) is differentiated rather than
duplicative. OpenClaw demonstrates demand for an open, self-hosted, customizable
personal assistant spanning tools and channels. Chief Moa's browser wedge is a
visual, voice-first interface that inhabits the work itself, teaches through
grounded interaction, and can express results as live interfaces and artifacts.

## Teach, Collaborate, And Do

“Teacher” and “agent” should not be forced into one irreversible product
choice. They are explicit interaction policies over the same grounded browser
context and action boundary:

- **Coach (default):** explain, point, visualize, wait, verify, and adapt. The
  assistant does not perform the step. This optimizes learning and user agency.
- **Collaborate:** the user performs most work but may ask “do this step” or
  approve one proposed action. The assistant explains what it did and verifies
  the result.
- **Delegate:** the user gives a bounded outcome and the browser agent performs
  an approved sequence with visible progress, stop control, and receipts. This
  is opt-in per task/profile, not inferred from urgency or model output.

All three modes use the same lesson/goal record, page epochs, stable element
references, proposal validation, and receipts. Switching mode changes action
authority and narration style; it does not fork memory or page state. The user
can move from “teach me” to “do this one” and back without restarting the task.

This is fundamentally an interface product. Voice is the low-friction intent
channel, but the response may be speech, a grounded highlight, a stepper, a
table, a diagram, an editable canvas, an approval, or live run state. Chat text
is one rendering choice, not the product container.

## Dynamic Page Context Model

Each browser tab gets a monotonic `page_epoch`. The extension advances it on
meaningful navigation, focus/selection, viewport, or semantic DOM change after
debounce and noise filtering. Context sent for a turn includes the evidence
needed for that moment only:

- tab/origin/title and `page_epoch`;
- bounded interactive/accessibility snapshot with stable element refs;
- active element, selection, viewport, and navigation state;
- on-demand visible screenshot with capture timestamp;
- optional adapter context such as Figma selection/node IDs and design
  structure;
- explicit provenance, limits, exclusions, and freshness for every source.

The gateway binds teaching instructions and action proposals to the observed
`page_epoch` and referenced elements. Before highlighting, instructing, or
acting, the extension verifies the epoch/ref. If stale, it resnapshots and asks
the gateway to re-ground instead of guessing.

`MutationObserver` is not streamed to the gateway. It marks local semantic
context dirty. A bounded adapter decides whether the change matters and creates
a new snapshot only when required by an active lesson or explicit user turn.

## Teaching Loop

```text
user states a learning goal
  -> extension captures current page evidence
  -> gateway proposes a bounded lesson plan
  -> side panel shows goal + current step + why it matters
  -> on-page guide points to one grounded element or region
  -> user acts (or explicitly approves an agent action)
  -> extension observes a meaningful page-epoch change
  -> gateway/adapter verifies the step predicate
  -> guide explains the result and advances, repairs, or asks a question
  -> lesson ends with a recap, reusable artifact, and optional recording
```

The system teaches rather than merely automates:

- Default mode is “show me, let me do it.”
- “Do this step for me” is a separate action proposal using the existing browser
  broker and receipts.
- Each step has an observable completion predicate; narration alone does not
  advance the lesson.
- The user can ask “why?”, “repeat,” “show me,” “do it,” “back,” or “stop.”
- Corrections update the lesson revision without erasing prior evidence.

## Generated Artifact Model

Use a graduated renderer rather than arbitrary page injection:

### Tier A: declarative and trusted renderer

Extend the existing UI spec with bounded `table`, `timeline`, `steps`,
`flowchart`, `chart`, `callout`, and `lesson_progress` components. Data is
validated JSON; packaged extension code renders it. This should handle most
teaching artifacts predictably and portably.

### Tier B: sandboxed rich artifact

Use the existing hard sandbox contract for content that genuinely needs
interaction or custom visualization. The gateway stores a versioned artifact;
the extension validates it and renders it in a packaged sandbox page without
Chrome APIs, gateway credentials, raw DOM, network access, or direct action
authority. Artifact intents return to the packaged broker as proposals.

Tier B should open in the artifact tab/canvas by default, not crowd the on-page
guide. Preview/apply/revert and last-good recovery remain required.

### Page action remains separate

Generated UI does not gain page execution. Page actions continue through the
extension-owned allowlist, current-page revalidation, approval policy, and
receipts. Tier C `userScripts` remains a later explicit opt-in and is not needed
for the first teaching product.

## Screenshots, Video, And Recording

Use the least invasive evidence that solves the step:

1. Structured DOM/accessibility/adapter context for ordinary grounding.
2. One explicit screenshot when visual layout matters or structure is
   insufficient.
3. Low-rate sampled frames during an active canvas-heavy lesson only when state
   cannot be derived otherwise.
4. Full tab video only in an explicit user-started “record lesson” mode.

Recording produces a bundle rather than treating MP4 as the product database:

- tab video/audio artifact;
- user/assistant transcript;
- lesson revisions and step timestamps;
- page-epoch and bounded evidence references;
- generated artifacts and action receipts;
- a Markdown lesson recap with links into the timeline.

Raw recording defaults off, displays an unmistakable recording indicator, uses
a retention/deletion policy, and never begins from model output. Upload is
optional; a self-hosted user may keep the recording local and upload only the
derived recap/evidence manifest.

## Figma First Slice

The first vertical journey should be narrow:

> In Figma's browser app, help a new user create a frame, add text and a button,
> apply Auto Layout, and explain what changed at each step.

Context sources:

- screenshot and viewport for canvas appearance;
- normal DOM/accessibility nodes for browser chrome and any exposed controls;
- explicit Figma adapter using official selection/design context when the user
  connects it;
- page-epoch changes and adapter selection events for step verification.

The first slice does not need autonomous design generation. It needs grounded
teaching, visible progress, correction/recovery, and one generated artifact—for
example, a live hierarchy/Auto Layout diagram in the side panel or artifact tab.

## Self-Hosting And Distribution

- Publish one stable extension package with no provider keys.
- Let the user configure a local or remote Chief Moa gateway URL and device
  token, as the current architecture already intends.
- Keep models, connected accounts, durable lessons, artifacts, runs, and
  provider credentials on that gateway.
- Engine-served Tier A/Tier B data can change without repackaging privileged
  extension code.
- Support Chrome/Chromium first. Cross-browser packaging follows only after the
  first workflow is proven and the API differences are measured.

“You own it” therefore means the gateway, data, profiles, artifacts, and models
are self-hostable. The signed browser package remains stable and auditable
rather than downloading privileged code from that gateway.

## Electron/Desktop Browser Expansion

Electron is a viable later packaging adapter, but loading the existing Chrome
extension unchanged is not the durable boundary. Electron's official extension
support covers only a subset of Chrome APIs, loads unpacked extensions per
session, and explicitly does not aim for Chrome Web Store or arbitrary-extension
compatibility. Chief Moa currently depends on APIs and browser concepts whose
behavior must not be assumed equivalent.

The reusable boundary should instead be a browser-surface core with platform
adapters:

| Layer | Chrome extension adapter | Electron browser-shell adapter |
| --- | --- | --- |
| Surface UI | Content overlay, side panel, artifact tab | Packaged local companion UI beside a `WebContentsView` |
| Page evidence | Content script, accessibility/DOM snapshot, screenshot, optional CDP | Isolated preload/page adapter, `webContents` capture, optional DevTools protocol |
| Navigation/tab state | Chrome extension APIs | Main-process-managed `WebContentsView` and navigation model |
| Permissions/actions | Chrome permission and extension broker | Explicit Electron session permission handler and narrow IPC broker |
| Gateway protocol | Shared | Shared |
| Lesson/artifact contracts | Shared | Shared |

Do not start this extraction before the Chrome teaching journey proves which
contracts are actually stable. The first reusable candidates are data
contracts and pure reducers—page evidence envelope, page epoch, lesson/step
state, generated UI spec, action proposal, and receipt—not a premature shared
framework.

If the Electron shell is pursued:

- use `WebContentsView`; `BrowserView` is deprecated and Electron recommends
  avoiding the `<webview>` tag when possible;
- keep Node integration off for remote pages, context isolation and process
  sandboxing on, and expose only a narrow validated preload bridge;
- install explicit session permission, navigation, new-window, download, and
  external-open policies;
- never expose gateway credentials, filesystem, shell, or raw IPC to remote
  web content;
- track Electron/Chromium security updates as a release-critical operational
  obligation;
- treat arbitrary web content as hostile evidence exactly as the Chrome
  extension does.

Electron itself warns that it is not a general web browser security product and
that displaying arbitrary remote content expands the application's attack
surface. The shell should therefore follow only after the extension validates a
capability that users value enough to justify owning that maintenance burden.

## Smallest Coherent Delivery Plan

1. **Teaching contract and evaluation:** define lesson, step predicate,
   page-epoch binding, provenance, stop/correction, and the Figma journey. Add
   it to the voice-intent completion matrix before product code.
2. **Dynamic context:** add semantic dirty tracking and page epochs over the
   existing snapshot path; prove stale instructions fail closed.
3. **Teaching side panel:** add current goal, step, explanation, progress,
   repeat/back/stop, and evidence freshness to the existing side panel.
4. **Grounded on-page guide:** add selector/ref-bound halo/arrow/callout and
   step verification, preserving the small overlay.
5. **Tier A teaching artifacts:** add table/steps/flowchart/timeline and one
   Figma hierarchy/Auto Layout visual.
6. **Figma adapter:** connect official selection/design context with explicit
   user authorization; keep screenshot fallback and report adapter absence.
7. **Tier B artifact canvas:** implement the existing packaged sandbox contract
   for rich, editable artifacts.
8. **Explicit lesson recording:** add `tabCapture` only after the teaching loop
   works, with recording indicator, local-first storage, transcript/timeline,
   retention, and deletion evidence.
9. **Operational proof:** run the same Figma lesson on Windows and one other
   desktop OS/Chromium environment through the voice-intent completion loop,
   package a preview, and promote only after the active-reload safety gate.

## Observable Acceptance

The browser-first direction is validated when a first-time Figma user can:

1. start the lesson by voice;
2. see and hear one grounded instruction at a time;
3. perform each action themselves and have progress verified from fresh state;
4. recover after selecting the wrong object or changing the page unexpectedly;
5. ask why and receive a visual hierarchy/Auto Layout explanation;
6. finish with a durable recap and artifact;
7. optionally record the tab lesson with explicit consent; and
8. complete the journey on Windows without a Mac or provider keys in the
   extension.

Success evidence must distinguish deterministic adapter checks, live-provider
voice, real-browser page grounding, Figma API/selection evidence, user-observed
teaching usefulness, recording behavior, and deployed-package smoke. One class
cannot stand in for another.

## Alignment Questions

The browser-first, open-source, self-hostable direction and mobile-companion
expansion are now captured as the proposed primary product thesis. The
remaining choices before capability specification are:

1. Confirm **Coach** as the default interaction policy, with Collaborate and
   Delegate explicitly selected rather than silently inferred.
2. Confirm Figma's create-frame/text/button/Auto-Layout lesson as the first
   end-to-end teaching journey.
3. Confirm the Chrome extension as the first production vehicle and Electron as
   a later adapter only after the Chrome journey passes usefulness evaluation.
4. Confirm lesson recording remains a later explicit mode rather than part of
   default perception.

An affirmative decision authorizes converting this note into an OpenSpec
capability delta and narrow implementation tickets. It does not by itself
authorize implementation or deployment.

## Primary Sources

- Clicky macOS repository and MIT license:
  <https://github.com/farzaa/clicky>
- Clicky Chrome capability/privacy description:
  <https://clicky-ai.com/>
- Clicky Windows lesson-recording description:
  <https://clicky.foo/>
- OpenClicky macOS expansion:
  <https://github.com/jasonkneen/openclicky>
- OpenGenerativeUI repository and sandboxed artifact examples:
  <https://github.com/CopilotKit/OpenGenerativeUI>
- Chrome Side Panel API:
  <https://developer.chrome.com/docs/extensions/reference/api/sidePanel>
- Chrome tab capture API:
  <https://developer.chrome.com/docs/extensions/reference/api/tabCapture>
- Chrome visible-tab screenshot API:
  <https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab>
- MutationObserver:
  <https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe>
- Figma MCP server:
  <https://developers.figma.com/docs/figma-mcp-server/>
- Figma file/node API:
  <https://developers.figma.com/docs/rest-api/file-endpoints/>
- OpenClaw repository:
  <https://github.com/openclaw/openclaw>
- Electron Chrome-extension compatibility boundary:
  <https://www.electronjs.org/docs/latest/api/extensions/>
- Electron `WebContentsView` migration:
  <https://www.electronjs.org/blog/migrate-to-webcontentsview>
- Electron security checklist:
  <https://www.electronjs.org/docs/latest/tutorial/security>
