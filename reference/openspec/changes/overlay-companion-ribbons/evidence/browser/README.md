# Browser ribbon visual QA

These images come from the real unpacked extension running in headless Chrome
for Testing. `browser_extension/scripts/smoke-extension.mjs` drives the real
service worker and content script; it does not recreate the overlay in a test
page.

Reproduce the final evidence from `browser_extension/`:

```sh
AGEE_VISUAL_EVIDENCE_DIR="$PWD/../reference/openspec/changes/overlay-companion-ribbons/evidence/browser/final" npm run smoke
```

`single-buffer-final/` is the post-cleanup capture from 2026-07-29. It proves
the same three ribbon states after removal of `#agee-log`, `.agee-cue`, and the
last automatic panel opening on ordinary typed turns. The real-extension smoke
also asserts that exceptional control shells contain no user or assistant text.

## Evidence matrix

| Affordance | Evidence |
|---|---|
| Collapsed streaming tail | `final/browser-ribbon-collapsed-streaming.png`; smoke pins 28px height, a bounded 140-character rendered tail, leftward slide, transparent ribbon plate, and no companion collision. |
| Tap-to-expand transcript | `final/browser-ribbon-expanded-transcript.png`; smoke pins full retained text, wrapping, a height cap, fixed width, fixed companion position, and no page reflow. |
| Copy variants | `final/browser-ribbon-copy-variants.png`; smoke pins three rows, unavailable polished state, corrected default, and literal availability. |
| Full history handoff | `npm run verify` pins ribbon double-tap to `openHistoryPanel`, handled by the extension worker as a separate history surface. The overlay itself never becomes history or a chat panel. No history-surface screenshot was captured in this lane, so its rendered appearance remains a visual-QA gap. |

`baseline/` is the unrefined capture. `round-1/` records the first visual
refinement. `final/` is the frozen parity target: small mascot, charcoal
capsules, white text, explicit continuation mark, and collision-free bottom-edge
stacking. The large fixture text is deliberately repetitive so truncation and
retention bounds are observable; it is not a product transcript.

Two noninteractive Claude Code visual reviews read the PNG paths directly.
The requested `--model opus` alias resolved to `claude-opus-4-8` in Claude Code
2.1.212; no model was represented as Opus 5 when the CLI did not return one.
See `opus-round-1.json`, `opus-round-2.json`, and
`opus-final-acceptance.json` for normalized CLI results, exact image hashes,
prompts, critique, and dispositions. The raw Claude Code stream included each
PNG as base64 tool output and was intentionally not checked in; the normalized
result preserves all decision-bearing metadata without duplicating image bytes.
