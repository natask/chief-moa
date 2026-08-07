# Windows Literal-Dictation Candidate Verification — 2026-08-07

## Candidate

- Source commit: `57c17627ce32dff6906a9f51ffc18afcfce79a71`.
- The unsigned WinUI source exposes Dictation as a separate activity, opens the
  microphone only after exact gateway draft authority, and keeps assistant
  voice absent rather than overloading the dictation path.
- Visible Start, Cancel, Pause, Resume, Finish, editable transcript, and Copy
  controls have stable Windows Automation ids.
- The client streams bounded mono 16 kHz PCM16, drains audio before Pause or
  Finish, resumes only after a newer acknowledgement for the same draft, and
  rejects stale authority, unsupported capabilities, assistant text, assistant
  audio, malformed events, oversized queues, and stalled finalization.
- The only local persistence is a flushed, atomically replaced pointer holding
  draft id, revision, session, branch, turn, and state. A retained or unreadable
  pointer blocks silent replacement by a new capture.

## Automated evidence

- Portable authority: `cargo fmt --check`, `cargo test --locked` (27 passed),
  `cargo clippy --all-targets -- -D warnings`, and
  `cargo build --locked --target x86_64-pc-windows-msvc` passed.
- Provider-neutral .NET protocol/controller: .NET SDK 8.0.423 compiled the
  linked production sources and `dotnet test` passed 9 tests covering explicit
  start, exact draft readiness, ordered audio drain, pause/resume, cancel,
  finish, transcription-only completion, assistant rejection, pointer
  persistence, and silent-overwrite refusal.
- `dotnet format --verify-no-changes` passed for the .NET test project.
- `node windows_app/scripts/verify-dictation-source.mjs`, XAML/project XML
  validation, strict `voice-capture-notebook-ime` OpenSpec validation,
  `node scripts/source-size-policy.js`, and `git diff --check` passed.
- A macOS `dotnet build` restored the WinUI dependencies, then stopped at the
  expected platform boundary because Microsoft's Windows
  `XamlCompiler.exe` cannot execute on macOS (exit 126). This is not recorded as
  a WinUI build pass.

## Non-installed artifact

- `windows_app/dist/Ag-Windows-Dictation-QA-57c17627ce32.zip`
- Size: 1,963,995 bytes.
- SHA-256:
  `80869e42f9932f82c6c1d1ad9e926dc1f60b4b5b49ff44419734057af52dea6a`.
- The archive contains the exact WinUI and test source plus the compiled
  `x86_64-pc-windows-msvc` portable authority library. Its manifest explicitly
  says it contains no WinUI binary and is unsigned, uninstalled, and unshipped.

## Remaining Windows gates

- Run the committed Windows workflow and require the .NET tests plus unsigned
  WinUI/MSBuild job to pass on a Windows runner.
- On supported Windows 10 and 11 hardware, prove microphone privacy denial and
  recovery, real 16 kHz capture, visible listening state, Pause releasing the
  microphone, same-draft Resume, ordered Finish against the production gateway,
  Cancel with zero transcription, editable output, clipboard copy, keyboard
  navigation, Narrator labels/live regions, and bounded resource use.
- A preserved pointer currently prevents source overwrite after restart, but
  this slice does not yet resume or discard that retained draft after a process
  restart.
- The system-wide summon, assistant-voice activity, MSIX/App Installer choice,
  package identity, publisher certificate, Authenticode signing, installation,
  relaunch, update, rollback, and uninstall evidence remain open.
- No application was installed, replaced, published, or deployed.
