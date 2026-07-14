# Windows lane claims ledger

| Claim | Evidence | Verdict |
|---|---|---|
| Protocol 2/1 portable Windows surface core exists | `windows_app/core`; 20 local tests | verified |
| Full surface/session/state/time/approval binding | opaque local approval capability, hostile fixtures and gateway digest fixture | verified for deterministic core |
| No provider key, canonical history or effect implementation | owned-source/dependency inventory | verified for owned paths |
| Foreground-app context can resolve bounded adapter advertisements | deterministic `context_descriptor`/`execution_adapters` fixtures | verified for portable data core only; no UIA observation or authentication inference |
| Standard Windows update metadata can be checked for eligibility | Store/App Installer hostile fixtures | verified for data-only seam; no download, signature, install, restart or rollback |
| Windows MSVC target compiles | local cross-build command | measured cross-build PASS |
| Native Windows application builds/runs | no WinUI/.NET/MSBuild/Windows runtime | unproven / not claimed |
| Secure storage, UX/accessibility, packaging, signing, install/runtime update | deliberately absent | not implemented |
| Performance or resource score | no benchmark/profiler run | unmeasured |
