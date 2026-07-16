## 1. Canonical Browser Gesture Contract

- [ ] 1.1 Remove the browser `ageeVoiceFirstGesturesEnabled` rollout branch and
      make the review-before-send map the packaged default for fresh installs,
      upgrades, service-worker restarts, and content-script reinjection.

      Acceptance: with no stored preference, one mascot click starts a draft
      with visible `X` and Send controls; a second mascot click does not send;
      `X` discards; Send commits exactly once.

- [ ] 1.2 Remove the user-visible voice-first gesture checkbox and its storage
      mutation path. Do not replace it with another setting, hidden preference,
      or remotely supplied flag.

      Acceptance: Options contains no gesture rollout control, and static
      verification finds no product path that can restore the legacy browser
      click map from stored configuration.

- [ ] 1.3 Make the browser click classifier deterministic across single,
      double, triple, hold, and drag input so a supported gesture cannot fall
      through to `openOptions`.

      Acceptance: isolated gesture tests prove each chord has one disposition,
      pending drafts are never silently sent, and Options opens only through an
      explicit permission-recovery action.

## 2. Permission Recovery Interaction

- [ ] 2.1 Display microphone failure and the first recovery instruction in the
      active voice surface before transitioning to Options focused on Voice
      permission.

      Acceptance: the user sees what failed, why the page is opening, and the
      exact Grant microphone control to use; the agent does not claim it can
      grant Chrome permission itself.

- [ ] 2.2 Prevent repeated capture failure, retry, or gesture echo from opening
      duplicate Options tabs or creating a recovery loop.

      Acceptance: one failed capture produces one visible error and at most one
      focused Options transition until the user retries explicitly.

## 3. Verify And Release

- [ ] 3.1 Run `cd browser_extension && npm run verify && npm run smoke` with an
      isolated browser profile and add deterministic coverage for the canonical
      gesture and microphone-recovery cases.
- [ ] 3.2 Bump the manifest patch version, package the extension, and record
      package and reload evidence separately under the active-promotion gate.

      Acceptance: verification, package creation, loaded-extension reload, and
      post-reload smoke are never inferred from one another.
