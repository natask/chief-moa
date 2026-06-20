## ADDED Requirements

### Requirement: Quiet headless extension run
Development and QA SHALL load and exercise the real unpacked extension headless
and off-screen using Chrome for Testing with a throwaway profile. It SHALL NOT
show a window, take focus, prompt the developer mid-run, or use the user's daily
browser profile.

#### Scenario: Real extension loads headless
- **WHEN** the harness launches Chrome for Testing `--headless=new` with `--load-extension`
- **THEN** the agee `service_worker` target appears in the DevTools target list and the extension id is captured, with no visible window and no focus change

#### Scenario: Smoke tests the real extension
- **WHEN** `npm run smoke` runs
- **THEN** it exercises the loaded extension headless and reports it did so, rather than falling back to the content-script harness

### Requirement: Background reload loop
The dev/reload loop SHALL run in the background without launching a visible
browser window and SHALL NOT use `open`/`open -a`.

#### Scenario: Edit reloads without a window
- **WHEN** a file under `extension/` changes while the background loop runs
- **THEN** the extension reloads against the headless instance with no window shown

### Requirement: Explicit opt-in visible path
A visible browser session SHALL only occur when the developer explicitly asks
for it, documented separately from the default quiet flow.

#### Scenario: Developer asks to see it
- **WHEN** the developer explicitly chooses the visible path
- **THEN** the documented manual `chrome://extensions` → Load unpacked route is used and is the only visible flow
