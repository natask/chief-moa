# Cross-Tab Agent Ownership

## Raw User Intent

- The user should speak to one browser agent, not to every open tab.
- Browser agent state should be shared across tabs instead of owned by one page's
  content script.
- If the user asks for work on one page, Moa should be able to say that page is
  finished, and the user should be able to return to that page and continue.
- The browser surface should not expose full chat history. It should show the
  current or latest intent/result, and history should be retrieved by asking.
- Asking "what is the progress in X?" is a new turn. It may become a second
  agent or status agent, and those agents need to synchronize through Moa state.

## Product Decision

The browser extension needs a single active browser-agent owner per configured
engine session. The owner is the tab/page/run that currently has the right to
listen, speak, and show browser-local task cues. Other tabs may show passive
status, but they must not capture microphone audio, play assistant speech, or
claim browser-local tasks for the same active owner.

Ownership must live in shared extension/gateway state, not only in a content
script. A useful owner record includes at least the browser session id, tab id,
page URL/title, voice session id if listening, active agent run id if any, and a
last status/result summary.

Starting a browser agent or voice turn from another tab transfers ownership. The
old owner tab must receive an owner-revoked state, stop listening, stop queued
assistant playback, and clear any browser-local task cues. The new owner becomes
the only tab allowed to listen or speak.

The overlay remains a last-intent surface. It may show the current input, latest
reply, latest run status, and page-finished cue, but it should not render visible
scrollback. Durable history, prior page work, and active-run status remain
gateway-owned context that the user can ask for by intent.

Progress questions are brokered turns, not UI history lookup. When the user asks
"what is the progress in X?", the gateway should answer from active run state
when possible, or launch a focused follow-up/status agent with `wait=false` when
the answer requires work. Related agents synchronize by reading and writing
shared broker events, route decisions, agent-run events, browser-task receipts,
and artifacts rather than relying on provider session memory.

## Acceptance Criteria

1. With two tabs open, starting voice in tab A makes tab A the active owner; tab
   B can show passive status but does not listen or play assistant audio.
2. Starting voice or page-agent work in tab B transfers ownership; tab A receives
   revoked status and stops microphone capture, queued playback, and local task
   cues.
3. A page task started from tab A can complete while the user is on tab B; tab B
   can report that the page task finished, and returning to tab A shows the
   latest page-finished state without rendering old chat scrollback.
4. Asking "what is the progress in X?" creates a normal broker event. The route
   decision either summarizes active run state or launches a focused follow-up
   agent/run linked to the relevant active work.
5. Verification covers real multi-tab behavior through the extension service
   worker/background state, not a single-page mock. The test should prove that
   non-owner tabs do not call page `getUserMedia`, do not use browser Web Speech
   APIs, and do not claim browser tasks for the active owner.

## Follow-Up Tickets

- Add a formal OpenSpec requirement for cross-tab browser-agent ownership under
  `extension-gateway-roundtrip` once the existing spec diff is clean.
- Add a browser-extension smoke that opens two tabs, transfers ownership, and
  asserts owner revocation behavior in the first tab.
- Add a gateway/broker smoke proving a progress question can route to active-run
  summary or a linked follow-up agent without canceling existing work.
