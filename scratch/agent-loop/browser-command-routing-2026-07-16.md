# Browser Command Routing Release Evidence

- Implementation commit: `1d92ab7f6a34c37c58102b45ea82a534b02cbb3f`
- Extension version: `0.1.66`
- Release artifact: `browser_extension/dist/A.G.-0.1.66.zip`
- Artifact size: `438365` bytes across 53 files
- SHA-256: `9b1223f052bf2004e0f07f2221cc935647ff0343a40eef867a0ac52388490c59`
- Extension verification: `npm run verify`, `npm run smoke`,
  `npm run smoke:user-scripts`, and `npm run smoke:cdp` passed sequentially.
  The ordinary-composer smoke opened Amazon results through the local facade
  with an unreachable gateway and rendered the local receipt.
- A first `npm run smoke` attempt hit the existing voice-shortcut timing
  harness; an isolated rerun passed. The changed browser-command behavior was
  not on the failing assertion path.
- OpenSpec: `openspec validate browser-situated-agent-experience --strict`
  passed.
- Gateway compatibility: `node --test test/source-size-policy.test.js` passed.
  No gateway source changed. A full gateway check attempt reached an unrelated
  long-running intent-history test and did not produce a reliable result.
- Independent verification: exact commit
  `1d92ab7f6a34c37c58102b45ea82a534b02cbb3f` passed `npm run verify`, the
  real Chrome extension, userscript, and CDP smokes, strict OpenSpec validation,
  and gateway source-size checks in a fresh detached worktree. The verifier
  independently observed the typed Amazon command and visible local receipt;
  its final worktree and candidate identity were clean.
- Untested runtime risk: no real microphone or live voice-provider socket was
  exercised. Finalized voice-command routing is covered by policy tests.
- Active reload: blocked. The user's ordinary browser may contain active work,
  so the no-interruption gate is not proven and no dev-reload signal was sent.
  The packaged artifact is the safe handoff and rollback boundary.
