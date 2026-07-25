# Audio history extension slice

## Outcome

Chief MOA exposes one authenticated, read-only projection of retained user
audio. The browser extension has an explicit **History** entry point that lists
the projection, plays original audio, shows transcript revisions and provenance,
and invokes the existing non-destructive voice-turn retranscription path.

## Contract

- `GET /v1/audio-history` returns newest-first retained voice turns and audio
  notes. Stable opaque record IDs are derived from source identity.
- `GET /v1/audio-history/:id` returns the same record with normalized transcript
  revisions.
- `GET /v1/audio-history/:id/audio` streams the original user recording through
  the gateway with `Cache-Control: private, no-store`.
- Capture blocks are not scanned because they project voice turns and would
  create duplicate audio records.
- Existing voice transcripts become immutable display revisions. The selected
  revision is explicit. The original stays visible after retranscription.
- Audio notes remain `not_transcribed`; the slice does not introduce automatic
  paid transcription.
- Every route requires the existing gateway bearer boundary. The browser
  extension never puts credentials, record IDs, or transcript data in a public
  website URL.

## Security scope

This slice is intentionally for the existing single-user/self-hosted gateway
trust model. A shared gateway bearer token is not multi-user authorization.
Do not expose a hosted `agee.app/history` archive until the website has a real
end-user session, subject-bound gateway assertions, CSRF protection, and
cross-user denial tests.

## Deferred work

- Subject-bound multi-user ownership and a hosted web archive.
- Async transcription jobs, idempotency keys, full provider operation metadata,
  and batch recognition for long recordings.
- Range requests and a durable database index for very large archives.
- Explicit transcription of audio notes.

## Acceptance evidence

- A voice turn and an audio note produce exactly two records.
- Voice revisions retain the original and selected retranscription separately.
- Anonymous list/detail/audio access is denied.
- Extension History is visible, authenticated, and exposes playback,
  provenance, revisions, and explicit retranscription.
