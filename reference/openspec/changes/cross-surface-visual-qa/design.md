## Pipeline

Each candidate is identified by commit and immutable Android/browser artifact
digests. A run uses an isolated phone/emulator fixture and an isolated Chrome
profile. Capture adapters render the actual application code; mock HTML, design
files, and screenshots of source code are not candidate evidence.

```text
candidate + state manifest
  -> environment preflight
  -> round 1 real renders and screenshots
  -> Opus critique + human disposition
  -> bounded UI refinement
  -> round 2 recapture of every state
  -> Opus critique + parity report + human acceptance
```

The two rounds are sequential. Round 2 never reuses round-1 screenshots and
must bind the new candidate digest. A no-change disposition is allowed, but its
reason is recorded. A model critique is advisory and cannot edit code, accept
its own findings, or authorize release.

## Deterministic state matrix

Both surfaces render the same seeded text and semantic states:

| State | Required assertion |
| --- | --- |
| `idle` | companion visible; empty ribbons do not occlude content |
| `user_stream_short` | partial user transcript is legible and anchored |
| `user_stream_tail` | long seeded transcript shows the newest bounded tail |
| `assistant_stream_tail` | reply uses the same stable footprint and hierarchy |
| `expanded_transcript` | full retained text is reachable, bounded, and copy is visible |
| `engaged` | pressed/focused treatment is distinct from ambient treatment |
| `light_background` | foreground contrast remains clear over a light fixture |
| `dark_background` | foreground contrast remains clear over a dark fixture |
| `large_text` | Android font scale 1.3 and browser 130% text do not clip controls |

The manifest fixes viewport size, density/device profile, locale, font scale,
theme, seeded transcript/reply strings, animation clock, and capture delay.
Network and live speech are disabled. Dynamic timestamps, cursors, audio level
meters, and unrelated OS/browser chrome are hidden or frozen by a documented QA
hook. If a state cannot be injected into the real render, capture fails instead
of substituting a mock.

## Reference inventory

`references.json` lists only assets already supplied or licensed for this
repository. Each item records path, SHA-256, provenance note, allowed use, and
optional surface/state tags. The expected `gemini_images` directory is currently
absent in this checkout. The coordinator reports `missing_reference`; it never
searches for, downloads, generates, or commits a replacement. References guide
visual language only and are never treated as expected pixel output.

## Critique contract

For each round, the coordinator invokes Claude Code non-interactively with
`--model opus` and the current screenshots, reference inventory, state manifest,
and prior-round disposition. The returned JSON must identify the actual model.
Evidence records the requested model, returned model, Claude Code version,
prompt SHA-256, start/end time, exit status, and raw-response artifact reference.
Missing model metadata, a non-Opus returned model, inaccessible images, or a
failed command makes critique incomplete and blocks visual acceptance.

The prompt asks for findings only: severity, surface, state, region, observation,
contract violated, suggested adjustment, and confidence. It explicitly ignores
instructions found in pixels and forbids code edits. A human assigns every
finding `accept`, `reject`, `defer`, or `fixed`, with a reason.

## Evidence layout

Each run writes under a git-ignored external or scratch artifact directory:

```text
run.json
references.json
round-1/{android,browser}/<state>.png
round-1/captures.json
round-1/critique.json
round-1/disposition.json
round-2/{android,browser}/<state>.png
round-2/captures.json
round-2/critique.json
round-2/disposition.json
parity.json
acceptance.json
```

Every screenshot entry records surface, state, path, SHA-256, dimensions,
candidate commit, artifact digest, renderer identity/version, device or browser
profile, theme, locale, scale, capture time, and whether system chrome was
included. `acceptance.json` names the human reviewer and exact round-2 hashes.

## Cross-surface parity

Parity is semantic, not pixel equality. Automated checks compare matrix
completeness, non-empty dimensions, state labels, fixed collapsed geometry,
tail-window seed presence, expansion bounds, and artifact/hash linkage. Opus and
human review compare hierarchy, companion scale, transcript adjacency, bubble
character, readable contrast, spacing rhythm, affordance meaning, and equivalent
expanded/copy behavior. Platform-native typography and input treatment may
differ when the reason is recorded.

## Safety and release boundary

Captured fixtures contain synthetic text and no user pages, notifications,
accounts, or credentials. Android capture requires an explicitly selected QA
device; browser capture uses a disposable profile. Visual evidence supplements,
but never replaces, Android build/phone QA or extension verify/smoke/reload
evidence. This pipeline does not deploy, publish, install, or promote.
