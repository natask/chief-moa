# Windows lane claims ledger

| Claim | Evidence | Verdict |
|---|---|---|
| Protocol 2/1 portable Windows surface core exists | `windows_app/core`; 27 local tests | verified |
| Full surface/session/state/time/approval binding | opaque local approval capability, hostile fixtures and gateway digest fixture | verified for deterministic core |
| No provider key, canonical history or effect implementation | owned-source/dependency inventory | verified for owned paths |
| Foreground-app context can resolve bounded adapter advertisements | deterministic `context_descriptor`/`execution_adapters` fixtures | verified for portable data core only; no UIA observation or authentication inference |
| Standard Windows update metadata can be checked for eligibility | Store/App Installer hostile fixtures | verified for data-only seam; no download, signature, install, restart or rollback |
| Windows MSVC target compiles | local cross-build command | measured cross-build PASS |
| Native Windows application builds/runs | no WinUI/.NET/MSBuild/Windows runtime | unproven / not claimed |
| Literal dictation source candidate | `Aggie.Windows` explicit capture UI, exact `voice_drafts_v1` protocol projection, NAudio PCM16 adapter, fail-closed WebSocket transport, pointer-only persistence, and pure .NET tests | implemented-unverified until Windows-hosted test/build result |
| Cancel/Pause/Resume/Finish remain visible and exact-draft-bound | XAML automation ids plus `DictationController` and `DictationProtocol` transition validation | source-verified; physical Windows behavior unproven |
| Assistant output cannot enter dictation | `transcription_only:true`, literal delivery intent, assistant event/binary-frame rejection | deterministic protocol test/source evidence; live gateway QA pending |
| Secure storage, UX/accessibility, packaging, signing, install/runtime update | deliberately absent | not implemented |
| Performance or resource score | no benchmark/profiler run | unmeasured |
