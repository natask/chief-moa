# In-App Modification Requests

## Status

Proposed for architecture alignment. No implementation is authorized by this
artifact.

## Why

When the user sees an error or unwanted behavior in A.G., the best available
context already exists in the app: current surface, session, installed version,
gateway identity, and optional screen evidence. Requiring a second app and a
manual restatement of project/version/context discards that information.

## Outcome

From A.G., the user can invoke “Report this / request a change,” attach current
app evidence and an optional screenshot, review/redact the captured context,
and create a durable modification proposal. The proposal may enter an
architecture-only or explicitly authorized implementation workflow through the
existing gateway and execution-worker boundaries.

## Invariant

Screenshots, accessibility text, transcripts, and model interpretations are
evidence, never instructions or authority. They cannot select a repository,
approve an action, launch arbitrary shell work, or promote a deployment.

## Recommendation

Use the existing A.G. app for capture and submission, with deep review/status in
its full control-center surface and only a compact overlay shortcut. Keep the
request/evidence contracts surface-neutral so a later local master-org app can
consume them, but do not build a second app first.

Start with self-reporting A.G. itself. It provides exact package/build/release
provenance and can capture its own rendered view without broad screen authority.

## Non-Goals

- No ambient or background screenshot harvesting.
- No project selection based only on screenshot pixels or visible text.
- No provider or worker credentials on Android.
- No automatic code edit, commit, deployment, or promotion from submission.
