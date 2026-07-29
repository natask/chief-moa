## 1. Freeze identity and migration contracts

- [ ] 1.1 Inventory active user-facing and spoken `Moa`, `Chief Moa`, `Aggie`,
      `A.G.`, `A-G`, `AG`, `assistant`, `pet`, and `friend` language.
- [ ] 1.2 Classify every remaining old name as historical evidence, required
      compatibility alias, migration copy, or defect; add automated checks for
      accidental active-product regressions.
- [ ] 1.3 Define the new `ag.companion` release application/channel and explicit
      retirement behavior for `ai.moa.assistant`.

## 2. Create the clean Android app identity

- [ ] 2.1 Change application id, namespace/source packages, manifest authorities,
      deep links, backup rules, tests, and distribution metadata to
      `ag.companion`.
- [ ] 2.2 Render exactly `Ag` in the packaged APK across launcher, permissions,
      accessibility, notifications, shortcuts, settings, and app UI.
- [ ] 2.3 Prove parallel installation does not overwrite, inherit permissions
      from, or receive app-private secrets from `ai.moa.assistant`.
- [ ] 2.4 Reauthenticate and restore only authorized gateway-owned continuity.

## 3. Build progressive onboarding

- [ ] 3.1 Implement resumable onboarding state driven by live Android capability
      checks.
- [ ] 3.2 Complete account connection, contextual microphone request, one real
      verified conversation, and notification choice as the initial path.
- [ ] 3.3 Implement reusable explain/open/return/verify/demonstrate steps for
      overlay, invocation role, accessibility, browser, integrations, and OTA.
- [ ] 3.4 Make optional steps skippable and available later in the full app.
- [ ] 3.5 Add blocked/declined recovery without false success claims.

## 4. Rename remaining active surfaces

- [ ] 4.1 Update active browser, web, gateway, Android, and desktop UI and speech
      to the Ag personal-AI-companion contract without changing trust ownership.
- [ ] 4.2 Migrate repository/external service names through explicit redirects or
      aliases where required; preserve historical receipts and source history.
- [ ] 4.3 Update current architecture, deployment, operations, and user docs once
      implementation paths use the new identity.

## 5. Verify and release

- [ ] 5.1 Run Android unit/UI/accessibility tests and assemble the new APK.
- [ ] 5.2 Test first run, interruption/resume, every decline/block/retry path,
      settings return detection, and live capability demonstrations.
- [ ] 5.3 Test clean install and parallel install on a real phone; verify package,
      visible name, signer, gateway continuity, permissions, and local isolation.
- [ ] 5.4 Publish the exact APK to an isolated device-reachable preview and record
      built, published, installed, activated, and smoked receipts separately.
- [ ] 5.5 Promote only through the lineage-safe stable authority when rollback,
      no-interruption, compatibility, backup/restore, and preview smoke pass.
