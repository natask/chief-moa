## Contract

- [x] Define deterministic states, references, two rounds, Opus metadata,
      evidence schema, and semantic parity.
- [x] Add a dry-run manifest validator/coordinator that performs no capture,
      model call, UI edit, or deployment.

## Implementation lanes

- [ ] Add an Android QA-only state injector and real-device/emulator screenshot
      adapter without granting screen-capture authority to production flows.
- [ ] Extend the existing real-extension smoke harness with a retained-artifact
      mode and deterministic visual-state injection.
- [ ] Add strict capture/evidence schema validation and screenshot hash checks.
- [ ] Add the bounded Claude Code `--model opus` critique runner and prove
      returned-model metadata using the installed CLI's supported JSON schema.
- [ ] Run round 1, disposition every finding, refine each surface in separate
      implementation units, then run round 2 and record human acceptance.
- [ ] Keep deployment and promotion as a separate gate after normal surface
      verification and accepted visual evidence.
