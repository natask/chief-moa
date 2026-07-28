## Contract

- [x] Define deterministic states, references, two rounds, Opus metadata,
      evidence schema, and semantic parity.
- [x] Add a dry-run manifest validator/coordinator that performs no capture,
      model call, UI edit, or deployment.

## Implementation lanes

- [x] Add an Android QA-only production-view renderer for collapsed and expanded
      transcript states without granting screen-capture authority to production
      flows. This is deterministic Robolectric native-graphics evidence, not a
      real-device/emulator screenshot adapter.
- [x] Extend the existing real-extension smoke harness with retained screenshots
      for collapsed, expanded, and copy states using Chrome for Testing.
- [ ] Complete Android real-device/emulator capture and deterministic injection
      for every state in the nine-state matrix.
- [ ] Complete browser deterministic injection and retained capture for every
      state in the nine-state matrix, including the rendered History surface.
- [ ] Add strict capture/evidence schema validation and screenshot hash checks.
- [ ] Add the bounded Claude Code `--model opus` critique runner and prove
      returned-model metadata using the installed CLI's supported JSON schema.
- [x] Retain two Opus critique/refinement rounds for the current Android
      collapsed/expanded production-view renders and browser
      collapsed/expanded/copy Chrome renders. The CLI returned
      `claude-opus-4-8`; it did not identify an Opus 5 model.
- [ ] Run two complete rounds over the full state matrix, disposition every
      finding, bind both surfaces to one candidate/artifact manifest, produce
      semantic parity evidence, and record human acceptance.
- [ ] Keep deployment and promotion as a separate gate after normal surface
      verification and accepted visual evidence.
