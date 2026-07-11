# Merge Ledger: 20260711 macOS Clicky-like Surface

| Time | Lane | State | Evidence |
| --- | --- | --- | --- |
| 2026-07-11 | User intent | complete | Scope corrected from spec-only/public-AX v1 to an implemented Clicky-like Mac capability using a user-owned Aggie server. |
| 2026-07-11 | Public-source research | complete | OpenClicky MIT source and installed Clicky mechanism evidence mapped; SkyLight is unnecessary for AX, focused-window capture, or semantic actions. |
| 2026-07-11 | Existing authority integration | complete | Audited Aggie surface protocol and Apple authority commits integrated serially into the isolated staging branch. |
| 2026-07-11 | Native implementation | BLOCK -> repaired -> PASS | Buildable `MoaMac`, visible scoped grants, recursive AX observation, opt-in focused-window capture, local/ask/trusted suggestion modes, Keychain token, exact request/response contracts, tests, and ad-hoc QA bundle. Live mutations remain safely disabled. |
| 2026-07-11 | Native auditor ring | BLOCK -> repaired -> BLOCK -> repaired -> PASS | Repaired app-switch leakage, post-capture/final window binding, Pause/Stop activation races, title/identifier redaction, request/response limits, exact local-only CGWindowID binding, and synchronous grant revocation. Final independent audit passed with 21 tests. |
| 2026-07-11 | Gateway implementation | BLOCK -> repaired -> BLOCK -> repaired -> PASS | Dedicated authenticated no-tools/no-persistence multimodal endpoint; aligned exact response schema; replaced structural JPEG claim with pinned bounded decoder; fake-provider redirect/oversize/stall/tool/function and recursive persistence tests. Final independent audit passed. |
| 2026-07-11 | Forensic revalidation | BLOCK -> corrected | Retained `/chat-tool-call` proves two JPEG screenshots were transmitted on a non-proactive route. Proactive samples remain AX/activity text only; periodic screenshot capture, trigger, and consent remain unproven. Cache-row versus archived HTTP timestamps corrected. |
| 2026-07-11 | Root verification | passed | Swift: 21 tests, debug/release `MoaMac` builds, package/signature checks. Gateway: 206 pass, 1 DB-gated skip, 0 fail; focused Mac/browser proactive smokes passed. Three relevant OpenSpec changes strict-valid; `git diff --check` passed. |
| 2026-07-11 | Serial commits | complete | Gateway `1bd9f62`, native Mac `7606ffe`, and evidence/specs `442115c`, following the integrated Aggie surface protocol/Apple authority commits. |
| 2026-07-11 | Release artifact | complete | Ad-hoc-signed `dist/MoaMac.app` (`app.agee.moa.mac`, version 0.1.0) zipped as `dist/MoaMac-qa.zip`, SHA-256 `c96332d01227ea741d684f79b9c8914287d99ee890e8c888dcf58116a34c2ee3`; packaged but never launched. |
| 2026-07-11 | Active promotion | BLOCKED safely | No isolated-account/VM TCC runtime QA, Developer ID/notarization/rollback artifact, or gateway preview/backup/restore/drain evidence. No production push, active-service restart, app launch, permission prompt, or live-user capture occurred. |

## Promotion boundary

No candidate launch or active promotion occurs without isolated TCC QA, stable
signing identity, notarization/rollback artifact, gateway preview and
backup/restore evidence, plus proof no active user session is interrupted.
