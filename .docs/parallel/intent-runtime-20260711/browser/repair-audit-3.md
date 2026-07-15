# Browser Draft Controls Repair Contract 3

## Audit disposition

`BLOCK`. Repair contract 2's lifecycle and real-Chrome gates pass, but the
shared protocol validator still performs lossy authority coercion. A hostile or
malformed gateway/persisted pointer can therefore become trusted draft
authority even though the gateway store requires exact tokens.

## Release blockers

1. `voice-draft-protocol.js` converts IDs with `String(...).trim()`. Numeric,
   boolean, leading/trailing-whitespace, path-like, control-character, and
   over-120-character draft/session/branch/turn values must be rejected, not
   repaired. Use the gateway grammar `^[A-Za-z0-9._:-]+$` and a 120-character
   maximum on both received and expected authority.
2. Persisted pointer aliases are selected with `||`. If two supplied aliases
   disagree, the first silently wins. Reject invalid or conflicting aliases;
   accept a value only when every supplied alias is exact and identical.
3. ACK and terminal validators turn an invalid expected base revision into
   zero. They must fail closed unless the expected base is a positive safe
   integer and all expected authority is canonical.
4. Canonical event action/state values are normalized with trim/lowercase.
   Protocol envelopes must use the exact vocabulary. Normalization may remain
   only at an explicit UI/config boundary.

## Required adversarial verification

- Reject numeric, boolean, whitespace-padded, path-like, control-character,
  empty, and overlong authority in stored pointers and every ready/ACK/terminal
  authority position.
- Reject conflicting persisted aliases and string/fractional/conflicting
  revision aliases.
- Reject ACK/terminal receipts when expected authority or base revision is
  malformed; no incoming receipt can compensate for invalid local authority.
- Preserve valid create, resume, ACK, sent, and discarded behavior.

## Verification after repair

```sh
cd browser_extension
npm run test:voice-capture-gesture
npm run verify
npm run smoke
git diff --check -- .
```

Do not commit, package, reload, merge, or deploy during repair. The main
orchestrator reruns the gates and assigns a fresh independent audit.
