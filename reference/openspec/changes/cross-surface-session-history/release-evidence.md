# Release Evidence: Cross-Surface Session History

## Candidate

- Repaired implementation candidate: `adeede01e1fdeb775f74dc29c99e225b6673b00d`.
- Release-only manifest bump: `43ca3a49` (`0.1.72` to collision-free `0.1.78`).
- Base: `26f7384f1919f37b38840c72035a85797bbe5375`.
- Verification and packaging used isolated worktrees, temporary gateway state,
  and headless Chrome profiles. No personal browser, phone, or foreground UI was
  touched.

## Verification

- `gateway/npm run check`: passed after lockfile-pinned dependencies were
  installed in the fresh worktree. Relational database integration tests were
  skipped by their normal environment gate; all enabled tests and quality gates
  passed.
- `gateway/npm run smoke:session-messages`: passed authentication, ordering,
  explicit-link deduplication, mixed sources, exact 12,269-character text, and
  unknown-session behavior against an isolated HTTP server and temporary state.
- `browser_extension/npm run verify`: passed.
- `browser_extension/npm run smoke:sidepanel`: passed in real headless Chrome,
  including first-open hydration, stable-ID deduplication, panel reopen, and
  extension/service-worker restart.
- `browser_extension/npm run smoke`: passed in real headless Chrome without a
  visible window or focus change.
- `android_app/./gradlew testDebugUnitTest assembleDebug`: passed.
- `openspec validate cross-surface-session-history --strict`: passed.
- Independent verification first rejected `ef0fe12f` for a 32,000/32,768
  Android display mismatch, permissive invalid limits, and unreported unreadable
  records. Candidate `adeede01` repaired all three. A fresh independent worktree
  proved exact 32,768-character Android display, HTTP 400 with no messages for
  five invalid bounds, and `unreadable=2` for corrupt voice and chat files while
  retaining only valid text. Focused gateway tests passed 12/12, Android unit and
  build checks passed, and the worktree remained clean.

## Artifacts

- Extension: `browser_extension/dist/A.G.-0.1.78.zip`, SHA-256
  `44164da16efb64a2b52b7ed79b3e350a16257b6d61766db6b73cd2bdf7a717a3`.
- Android isolated OTA store:
  `.context/artifacts/cross-surface-session-history/android-ota`, release
  `ai.moa.assistant-2026071602`, APK SHA-256
  `fe2ef0aa0e425bbceb30857485aa4b8c79298b1686f4545166d2810679777942`.
- The gateway session-message smoke is the isolated local preview for this
  bounded read-only route. The VPS promotion path must still create its own
  separate TLS URL, database, queue, storage, and worker pool before applying.

## Promotion Boundary

The artifacts were built without reloading the user's unpacked extension,
installing to an ADB device, or syncing an OTA store. Gateway promotion must go
only through `scripts/release/push-master.sh`; the VPS promotion controller then
requires isolated preview, backup/restore, compatibility, drain/resume, rollback,
and post-apply smoke evidence. Task 4.3 remains open until that path either
finishes or records its exact blocker.

`npm ci` reported two high-severity audit findings in the existing dependency
lock; this change did not alter gateway dependencies. They require a separate
dependency-review ticket rather than an unreviewed forced upgrade in this wave.
