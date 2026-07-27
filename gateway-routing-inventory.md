# Gateway User-Message Routing Inventory

Audit date: 2026-07-27

Scope: free-form user text that caused routing, classification, persistence, or
execution decisions in `gateway/`. URL matching, protocol validation, typed
enum dispatch, capability allowlists, and text retrieval/ranking are not user
intent matchers.

## Inventory

| # | Matcher | Prior behavior | Tool replacement / result |
|---|---|---|---|
| 1 | `gateway/lib/voice-intent.js:29` `STOP_PHRASES` / `isStopLike` | Silenced exact phrases such as “shut up.” | `stay_silent`; old parser remains as a compatibility export but no turn classifier calls it. |
| 2 | `gateway/lib/voice-intent.js:49` `wantsMultipleAgents` | Launched two agents for a keyword list. | Repeated `launch_agent_run` calls selected by the model. |
| 3 | `gateway/lib/voice-intent.js:83` `shouldRunAgentFromVoice` | Launched work from action verbs and operational phrases. | `launch_agent_run`. |
| 4 | `gateway/lib/voice-intent.js:112` `isOperationalStatusQuestion` | Prevented status questions from launching work. | `list_agent_runs`; ordinary answers remain chat. |
| 5 | `gateway/lib/voice-intent.js:145` `wantsAgentDispatch` | Authorized a launch tool by regex. | Model tool selection plus typed tool arguments; handler no longer reparses the transcript. |
| 6 | `gateway/lib/voice-intent.js:158` `explicitAgentPromptFrom` | Routed `/agent`, `/run`, and phrase prefixes. | `launch_agent_run`; typed client `intent_hint` remains available for explicit UI controls. |
| 7 | `gateway/lib/voice-intent.js:170` `parseProfileControlIntent` and helpers | Parsed language, voice, persona, name, modality, provider, sampler, echo, undo, and reset phrases into mutations/queries. | `update_agent_profile`, `revert_agent_profile`, `read_agent_settings`, `get_profile_options`, and `start_voice_sampler`. The parser remains for compatibility tests and legacy explicit profile-control hints, but free-form turns no longer invoke it. |
| 8 | `gateway/lib/voice-intent.js:840` `classifyVoiceTurn` | Selected control/profile/agent/chat from transcript text. | Free-form text always enters model chat/tool reasoning. Only typed client hints bypass it. |
| 9 | `gateway/lib/voice-router.js:112` `heuristicActions` / `cancelRunTargetFrom` | Fell back to regex routing when the router model failed. | Safe fallback is now plain chat. Model tools choose `cancel_agent_run`, `stay_silent`, profile tools, or agent tools. |
| 10 | `gateway/server.js:1831` `looksLikeBrowserPageQuestion` | Redirected browser voice to page Q&A from question regexes. | Typed page evidence/context or an explicit client hint selects the browser turn. Free-form text does not. |
| 11 | `gateway/server.js:3590` `localUtilityReply` | Answered time and operational status locally from phrase tables. | Normal model answer and `list_agent_runs`; the helper is retained but no user-turn path calls it. |
| 12 | `gateway/lib/work-history-intent.js:228` `parseWorkHistoryIntent` | Created work, queried status, attached feedback, proposed deploys, or emitted UI-open actions from regexes. | Removed from the generic voice-turn decision path. Durable work is reached through registered agent/control/capability tools. The parser remains for the dedicated legacy work-history endpoint. |
| 13 | `gateway/server.js:6686` `liveToolAllowsAgentRun` | Reparsed the transcript before honoring `launch_agent_run` or `launch_browser_agent`. | Model tool choice is authoritative; handler still requires a current user transcript and validates typed arguments/authority. |
| 14 | `gateway/server.js:6728` `liveToolAllowsProfileUpdate` | Allowed only language fields or fields independently found by the phrase parser. | Model tool choice is authoritative for every supported profile field; sanitizer, scope, and device checks remain. |
| 15 | `gateway/lib/memory-matcher.js:42` plus `captureMemoryFromTurn` call sites | Silently stored names, preferences, persona, and “remember” phrases. | `remember_user_fact`; automatic matcher calls were removed. |
| 16 | `gateway/lib/context-decision.js:49-83` incognito/fork/new phrase patterns | Filed turns into new, forked, or incognito threads from regexes. | `context_management`; typed client `context_action` still wins and missing tool use safely defaults to `continue`. |
| 17 | `gateway/lib/broker-router.js:136` `workflowRecommendation` | Selected QA, security, fuzzing, coding, design, research, or writing workflows by keyword tables. | Removed from `routeDecisions`; model agent/tool selection owns workflow choice. Helper remains exported for compatibility only. |
| 18 | `gateway/lib/broker-router.js:164` `looksLikeNewWork` | Created an extra fork from “new/another/fork” keywords. | Removed from `routeDecisions`; no-match safely creates one new fork. |
| 19 | `gateway/lib/broker-router.js:40-103` token overlap | Attached a message to sessions/projects/runs by lexical overlap. | Deliberately retained as evidence retrieval/ranking, not intent classification or action execution. Explicit IDs still outrank overlap. |
| 20 | `gateway/lib/broker-router.js:73-75` broadcast regex | Broadcast to active runs from “all/every agent” phrases. | Deliberately retained pending a broker model-tool schema; it only attaches/dismisses evidence and never executes or cancels work. Typed `fanout_all_active` is the preferred path. |
| 21 | `gateway/server.js:7514` `voiceMultiAgentHarnesses` | Chose named harnesses from transcript words. | Free-form turns no longer reach the legacy multi-agent classification; repeated model `launch_agent_run` calls carry typed harness values. Typed `multi_agent` hints retain compatibility behavior. |
| 22 | `gateway/lib/companion-catalog.js:1093-1212,1451-1454` prompt-to-companion heuristics | Derived a companion preset, tags, verbosity, palette, and motion from creation text. | Deliberately retained inside the explicit companion-creation tool handler as deterministic parameter derivation, not global message routing. |

## Count

22 matcher families were found. Nineteen were removed from generic
user-message decision paths or made tool-authoritative. Three remain narrowly:
broker evidence overlap, broker evidence fanout, and deterministic derivation
inside an explicitly selected companion-creation tool.

