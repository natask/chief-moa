# M3 R7 hostile sequencing matrix

All evidence is deterministic/local. Provider requests are captured stubs; no
live or paid model call was made.

| # | Contract case | Named evidence | Captured assertion |
|---|---|---|---|
| 1 | Chat model `continue -> new` | `smoke-context-decision.js:modelOverridesPrior` | Preflight excludes standing/caller sentinels; answer includes standing and excludes caller; response files on the planned new branch. |
| 2 | Chat model `continue -> fork` cutoff | `smoke-context-decision.js:modelForkExcludesPostCutoffTurn` | Local-only lifecycle hook writes a later parent turn after the immutable cutoff; captured answer includes the allowed parent sentinel and excludes the later sentinel. |
| 3 | Warranted model incognito | `smoke-context-decision.js:incognitoWarrantGate` | Separate preflight/answer captures, standing-only answer, `persisted:false`, and unchanged chat-turn count. |
| 4 | Unwarranted model incognito | `smoke-context-decision.js:incognitoWarrantGate` | Gateway denies the proposal before assembly and persists the deterministic-prior turn. |
| 5 | Explicit client actions | `clientActionBeatsModel`, `chatContextBlockAndPersistence`, `completedChatRetryIsIdempotent` | Explicit continue/new/incognito skip decision preflight; answer tool lists exclude `context_management`; exact scopes and persistence are asserted. |
| 6 | Preflight failure matrix | `preflightFailureMatrixFallsBackOnce`; parser unit test | No-tool prose, malformed args, unknown tool, duplicate calls, and thrown transport each make one preflight plus one normal answer, retain prior, and leak no prose. Unsupported-provider fallback is covered by the existing local/no-provider decision smoke. |
| 7 | Mutation attack | `context-decision-preflight.test.js`; `modelOverridesPrior` | Captured preflight offers exactly one tool (`context_management`); profile/phone/browser tool responses parse invalid and no handler can execute. |
| 8 | Cascaded streaming/non-streaming cold scopes | `smoke-cascaded-reasoner.js:modelSelectedColdScopesAreCaptured`; `incognitoClassificationHasNoDurableEffects` | Model-selected streaming new and non-streaming warranted incognito answers are standing-only; preflight precedes first answer request/delta; incognito persistence/action writes are absent. |
| 9 | HTTP voice cold scopes | `smoke-incognito.js:httpVoiceColdScopeMatrix` | Explicit new and warranted incognito captured answers include standing facts and exclude caller recency; phrasing-only new remains continue. |
| 10 | Completed retry/replay | `completedChatRetryIsIdempotent`; `completedCascadedRetryIsIdempotent` | Same stored response/branch returns with zero additional provider requests and no new branch. |
| 11 | Artifact-build failure | `smoke-context-decision.js:newArtifactFailureNeverLeaksCallerHistory` | Forced source failure for new and incognito remains fail-soft; captured answer requests contain no caller-history sentinel; incognito remains unpersisted. |
| 12 | OpenAI + Vertex request shapes | `context-decision-preflight.test.js`; `smoke-cascaded-reasoner.js:modelAndReasoningProviderRoute` | OpenAI forces named `tool_choice` with one tool and two messages; Vertex uses `ANY` with only `context_management` and one current-turn content; both exclude retrieval evidence. |

The direct lifecycle failure case required by the R7 audit is additionally
covered by `smoke-context-decision.js:answerFailureDoesNotMaterializePlan`: two
failed answer transports return 500 and a before/after `/v1/threads` comparison
proves no planned branch was created or switched.
