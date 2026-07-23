# Browser/macOS Dictation Release Evidence (2026-07-22)

## Candidate

- Implementation commit: `f651c784`
- Extension version: `0.1.85`
- Package: `browser_extension/dist/A.G.-0.1.85.zip`
- SHA-256:
  `60afa88c2990c2d05447930044ccdbd4c17be45e4109acddf8dfc6ca3bed2b4f`

## Verification

- `cd gateway && node scripts/smoke-chirp-provider.js`: passed; cascaded
  transcription-only turn made one Chirp request and zero reasoner calls.
- `cd gateway && npm run check`: passed with local test sockets enabled.
- `cd browser_extension && npm run verify`: passed, including 114 focused unit
  checks and extension policy verification.
- `cd browser_extension && npm run smoke`: passed against the real unpacked
  extension in isolated headless Chrome for Testing.
- `cd browser_extension && npm run package`: produced the candidate above.
- Karabiner-Elements and the existing double-Command A.G. rule are present on
  this Mac.

## Promotion blockers

- The production gateway change has no isolated preview URL/state, backup and
  restore receipt, or no-active-voice-session evidence for this candidate.
  Therefore it is not eligible for active promotion.
- The daily-browser extension was not reloaded because no-interruption evidence
  for current browser work was unavailable. The package is ready, but loaded
  version and clipboard behavior remain unverified on the daily browser.
- `openspec validate voice-capture-notebook-ime --strict` could not start because
  this checkout's OpenSpec CLI is missing its `commander` package dependency.

## Manual completion check

After a compatible gateway preview is available, load or reload extension
`0.1.85`, double-tap left Command to start, speak mixed English/Amharic,
double-tap again, return to the originating app, and paste. Confirm the pasted
text equals the visible literal transcript and no assistant reply is produced.
