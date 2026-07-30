# Browser send-time context release evidence

- Implementation: `4a8d03a4` (`feat(browser): bind turns to send-time page context`)
- Extension version: `0.1.129`
- Artifact: `browser_extension/dist/Ag-0.1.129.zip`
- Extension verification: `npm run verify` passed with 242 tests.
- Real-extension smoke: `npm run smoke` passed in headless Chrome for Testing.
- Unified browser-agent smoke: covered by the extension verification lane and passed.
- Gateway verification: `npm run check` passed.
- OpenSpec: strict validation passed.
- Repository source-size policy and `git diff --check`: passed.

Reload is intentionally blocked because browser work is active; sending the
development reload signal could interrupt it. Gateway preview and active
promotion are also blocked: this unit is on a feature branch and the shared
worktree contains unrelated dirty gateway paths, so the active-promotion gate
cannot prove an isolated deploy or safe target state. The packaged extension is
the safe release artifact for this unit.
