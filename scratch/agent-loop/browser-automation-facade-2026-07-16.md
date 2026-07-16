# Browser Automation Facade Release Evidence

- Implementation commit: `a276a6af`
- Extension version: `0.1.61`
- Release artifact: `browser_extension/dist/A.G.-0.1.61.zip`
- SHA-256: `de6e0f812455a26a47d900b1d5674c3f74307de4e4ea01c02ec61f892a01c0f7`
- Extension verification: `npm run verify`, `npm run smoke`,
  `npm run smoke:user-scripts`, and `npm run smoke:cdp` passed.
- Gateway verification: `npm run check` passed, including the repository
  source-size policy after extracting the facade executor from `background.js`.
- OpenSpec: `openspec validate browser-situated-agent-experience --strict`
  passed.
- Tweeks comparison bridge: temporary Codex MCP registration and Chrome native
  host manifest were removed; `@tweeks/mcp@1.1.0 status` reported
  `installed: false`.
- Active reload: blocked. The user's ordinary Chrome session contained active
  work during the black-box comparison, so the no-interruption gate was not
  proven and no dev-reload signal was sent. The packaged artifact is the safe
  handoff/rollback boundary.

