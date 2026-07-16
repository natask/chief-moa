# Chirp language regression recordings

This directory contains byte-exact PCM from two real user voice turns. The user
explicitly authorized committing these recordings so the automated suite can
protect the Geʽez/Amharic/English transcription path against regressions.

The files are sensitive biometric-like user speech, not synthetic samples.
They use pseudonymous fixture names and the manifest contains no production
session, user, branch, or turn identifiers. Do not copy them into logs, public
artifacts, examples, or provider requests outside the explicit paid live eval.

Git is durable: deleting a fixture in a later commit does not remove it from
existing history or clones. If the user revokes consent, repository-history and
clone retention must be handled explicitly in addition to deleting the current
files.

Both recordings are headerless PCM16LE, 16 kHz, mono. `corpus.json` records
their byte counts, SHA-256 hashes, durations, capture timestamps/surfaces,
observed bad Hindi/Devanagari transcripts, and accepted prompted replay
observations. Those observations prove only the current script-level policy;
the exact wording is not user-verified linguistic ground truth and must not be
used as a WER reference.

The default test is deterministic and network-free. A paid, credentialed Chirp
replay is separately opt-in:

```sh
VOICE_EVAL_LIVE=1 npm run eval:voice:chirp-language-regressions -- live
```

That evaluator performs STT only with production request composition: Chirp 3,
provider `auto`, and prompt policy `chirp-geez-amharic-english-v1`. It invokes
no reasoning model or TTS provider. Its output contains only fixture identifiers,
audio/transcript character counts, and script-policy status; it never prints the
recognized speech text.
