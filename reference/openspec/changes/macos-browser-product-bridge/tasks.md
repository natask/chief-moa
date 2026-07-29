## 1. Contract and fixtures

- [x] 1.1 Define separate-product ownership, identity, delegation, approval,
      lifecycle, receipt, cancellation, and disconnected behavior.
- [ ] 1.2 Add gateway fixtures for fresh, stale, disconnected, wrong-target,
      expiry, cancellation, and duplicate-delivery cases.

## 2. Gateway bridge

- [ ] 2.1 Reuse the device-client registry to list compatible browser targets
      without exposing browser session material.
- [ ] 2.2 Accept an explicit Mac-originated target-bound browser tool request
      with idempotency, argument digest, bounded expiry, and cancellation.
- [ ] 2.3 Project monotonic progress and terminal receipts to both products
      using the same request identity.
- Acceptance: the gateway never executes the browser effect, accepts claims and
  receipts only from the selected device, and never silently retargets work.
- Verification: gateway check plus device-hub bridge smoke.

## 3. Mac product

- [x] 3.1 Add browser-device discovery and an explicit target/outcome
      delegation affordance to the native Mac companion.
- [ ] 3.2 Queue and cancel the first `browser.tab.open` request and render its
      queued, offline, approval, executing, terminal, and expired states.
- [x] 3.3 Keep ordinary Mac chat, Mac actions, native permissions, and native UI
      independent of browser installation or availability.
- Acceptance: one explicit Mac request opens one HTTPS tab through the selected
  extension; with no extension, Mac reports unavailable and uses no AX fallback.
- Verification: `cd apple_surfaces && swift test && swift build --product Ag`.

## 4. Browser product

- [ ] 4.1 Claim only target-bound compatible requests and revalidate URL,
      argument digest, expiry, cancellation, and browser-local policy.
- [ ] 4.2 Render the delegated task and local approval in browser-native UI;
      post bounded progress and one idempotent terminal receipt.
- [ ] 4.3 Prove the extension remains usable without the Mac app and never
      receives Mac-local context or permission.
- Acceptance: duplicate delivery opens no second tab; wrong-device, expired,
  cancelled, invalid URL, and disconnected-lease cases produce no effect.
- Verification: `cd browser_extension && npm run verify && npm run smoke` plus
  the targeted device-client/CDP smoke.

## 5. End-to-end verification and release

- [ ] 5.1 Prove Mac -> gateway -> selected extension -> receipt with one HTTPS
      tab and matching request identity on both products.
- [ ] 5.2 Prove no-extension, offline-before-claim, disconnect-after-claim,
      cancellation, duplicate delivery, wrong target, expiry, and invalid URL.
- [ ] 5.3 Package separate Mac and extension artifacts. Installing one must not
      install, update, or grant permission to the other.
- [ ] 5.4 Promote each product independently only when its own active-promotion
      gates pass.
