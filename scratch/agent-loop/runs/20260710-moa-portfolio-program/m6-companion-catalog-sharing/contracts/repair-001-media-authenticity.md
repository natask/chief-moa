# M6 repair 001 — media authenticity

## Blocker

The fresh hostile audit reproduced JavaScript and PKZIP bytes accepted as
`image/png`. Declared media, path extension, decoded content, and dimensions
were not bound together, so the executable-media gate was gameable.

## Repair contract

- Bind each allowed media type to a non-executable file extension.
- Inspect bounded decoded bytes for the expected image/audio signature.
- Accept only fully parsed PNG and PCM WAV in v1; reject incomplete containers,
  invalid checksums/chunks, unsupported media, and bytes after the terminator.
- For images, derive dimensions from bytes and require exact agreement with the
  signed declaration; audio dimensions must be null.
- Reject instruction-bearing `system_prompt` as package-controlled state.
- Add hostile disguised-script, disguised-archive, extension-confusion,
  dimension-lie, PNG-polyglot, fake-audio, receipt-serialization, and
  prompt-injection tests.
- Validate serialized prior receipts from their bounded schema and content
  digest rather than process-local object identity.
- Do not add dependencies, archive extraction, routes, network I/O, trust roots,
  publication, profile mutation, or live execution.

## Acceptance

`cd gateway && node --test test/companion-package.test.js`, full gateway check,
and a fresh hostile auditor must pass.
