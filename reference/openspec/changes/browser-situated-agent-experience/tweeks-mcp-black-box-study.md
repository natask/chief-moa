# Tweeks MCP 1.1.0 Black-Box Study

## Scope

On 2026-07-16, Tweeks MCP 1.1.0 was temporarily connected to the locally
installed Tweeks 0.0.7.20 extension and exercised only through its documented
MCP interface. The native host and Codex MCP registration were removed after
the study. A.G. does not depend on Tweeks at runtime, and this study does not
authorize copying third-party source.

## Observable Capability Shape

The public tool catalog divides cleanly into two groups:

- userscript lifecycle: list, inspect, install, update, enable/disable, remove,
  import, export, and system diagnostics;
- browser automation: list tabs, navigate, screenshot, snapshot, query, read
  text, wait, click, fill, type, hover, scroll, evaluate, console/network
  diagnostics, and userscript menu commands.

The most useful interface properties are:

- every ordinary result uses a small `ok`, `summary`, `result`, `error`
  envelope;
- explicit tab IDs prevent accidental dependence on global active-tab state;
- element targeting supports semantic role/name/label/placeholder/test-ID
  locators in addition to CSS;
- text, snapshot, and query reads have caller-visible size bounds;
- missing targets return a compact diagnostic and identify the failure as
  retryable;
- dedicated actions are preferred over arbitrary evaluation;
- tool metadata distinguishes read-only, mutating, open-world, and destructive
  behavior.

## Behavior Exercised

- System diagnostics reported the connected extension/MCP versions and
  userscript state.
- Tab listing returned explicit tab identity, URL, title, active state, window,
  index, and load status.
- `browser_navigate` opened a new `example.com` tab and returned only after the
  page was loaded. The new tab became active; A.G. should retain its explicit
  background-tab option so automation need not steal focus.
- A bounded snapshot returned a compact DOM outline with visibility, inferred
  role, bounds, and actionable attributes.
- A semantic `role=link` query returned one compact element record with name,
  text, href, rectangle, and locator diagnostics.
- A missing CSS selector failed with a bounded, retryable diagnostic rather
  than inventing a result.

No user account workflow, purchase, form submission, or persistent userscript
mutation was performed.

## Incorporated Into A.G.

The first-party extension facade now exposes typed navigation, description-to-
Google/Amazon search, bounded snapshot/query/text/wait/screenshot, and locally
validated click/fill/type operations through A.G.'s existing gateway broker.
Page evidence now carries semantic role, name, placeholder, test ID, href, and
disabled state. Page actions accept either a fresh bounded element index or a
semantic locator, and a missing target returns a retryable local receipt.

The existing A.G. design remains stricter where it matters:

- page execution and approvals remain in the extension;
- risky clicks still require local target-app confirmation;
- background search/navigation can keep the user's active tab focused;
- generated persistent behavior uses A.G.'s opt-in, hash-bound
  `chrome.userScripts` artifact runtime;
- screen/page context remains evidence, never instruction.

## Follow-Up Gaps

1. Route normal typed/voice model turns to this local facade instead of making
   gateway tool requests a separate capability island.
2. Add image evidence ingestion and a product-search planner that can combine
   the image with a description before opening marketplace results.
3. Add semantic hover/scroll helpers and bounded console/network diagnostics.
4. Add generated-script creation/update/import/export workflows over the
   existing first-party userscript artifact store.

