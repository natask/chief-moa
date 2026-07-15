# Browser Draft Controls Repair Evidence 4

Status remains `BLOCK` pending a fresh independent audit.

The candidate repair now:

- rejects malformed expected create authority and validates resume authority as
  one complete strict pointer before creating a background session;
- validates ticket, branch-switch, start-response, commit, and control authority
  without string/whitespace repair;
- routes pre-ID SEND by exact tab plus turn, waits for any in-flight offscreen
  capture start, then stops and drains capture before queuing SEND;
- detects a start response that lost the cancellation race and sends draft
  discard (with close fallback) or ordinary close instead of attaching it;
- invalidates the endpoint capability generation and detaches the old pending
  promise on config changes; late responses cannot enable another endpoint;
- leaves admitted hold timers and tap chords intact when the feature flag
  changes; the new setting applies to the next admission;
- loads the shared protocol in both manifest and programmatic content injection
  paths.

Executable protocol regressions cover malformed local authority, pre-ID SEND,
late-start disposition, and endpoint generations. The verifier binds those
helpers to the actual content/background lifecycle bodies and rejects feature
listeners that clear admitted gestures.

Candidate gates:

- all three focused suites: pass;
- extension verifier and seven lifecycle tests: pass;
- real headless-Chrome extension smoke: pass after binding the mock capability
  response to its gateway URL;
- diff check: pass.

No commit, package, reload, merge, preview, or deployment was performed.
