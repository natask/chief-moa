# Tasks

- [x] Reuse the product-event substrate for intent, agent and notification streams.
- [x] Add authenticated create/read/list/update and explain routes.
- [x] Add manual agent registration and idempotent progress.
- [x] Add durable completion/needs-user notifications and receipts.
- [x] Prove restart rehydration, auth, confirmation and privacy boundaries.
- [ ] Wire an explicit gateway launcher adapter to register production launches.
      Next: register one production launch before execution. Complete when a
      smoke proves stable intent/agent/run identity and a terminal receipt.
- [ ] Add native views in MoaMac, Android, browser, web/ag.app and future iPhone.
      Next: ship one surface view at a time against the shared API. Complete
      when every named surface has independently verified intent, owner,
      liveness, recap/artifact, steering, and notification presentation.
- [x] Specify hosted authority, placement, security, steering, artifacts,
      recovery, context compaction, export, and reversible partitioning.
- [x] Add reversible tenant/namespace/sphere/project placement and filters.
- [x] Add agent runtime provenance, heartbeat leases, and stale detection.
- [x] Add explicit repeated-run start, terminal transition enforcement, and
      per-run terminal notification identity.
- [ ] Add exclusive recovery claims and addressed steering messages. Next:
      specify compare-and-set claims and message receipt state, then implement
      them. Complete when conflict and stale-owner tests prevent duplicate
      recovery and prove addressed delivery.
- [ ] Add typed relations and versioned artifact/recap aggregates. Next: add
      append-only schemas and projections. Complete when version, provenance,
      digest, and source-bound replay tests pass.
- [ ] Add scoped launcher/device identities before multi-user deployment.
      Next: add revocable principals and per-route tenant authorization.
      Complete when cross-tenant negative tests and rotation/revocation tests
      pass before multi-user enablement.
- [ ] Add complete ordered export manifests and a partition reconciler. Next:
      emit stream bounds, counts, versions, and digests, then rebuild a target.
      Complete when source and target projections compare equal and rollback to
      the retained source is proven.

## Local Codex adapter operational progress

This ledger covers the machine-local `codex exec` adapter and its host process
lifecycle. It does not describe the production gateway, change hosted gateway
limits, or claim a production remediation.

- [x] Capture and independently verify a read-only snapshot of the July 25
      `EMFILE` incident. Evidence: two Codex host processes held 251 and 253
      descriptors under a 256-descriptor soft limit; 162 and 171 pipe
      descriptors respectively matched three standard streams for 54 and 57
      direct children. System utilization was 12,857 of 368,640 file
      descriptors and 1,121 of 12,000 processes, so the snapshot supports
      per-process exhaustion rather than system-wide exhaustion.
- [ ] Determine whether completed work releases local child processes, pipes,
      sockets, and session files. Next action: from a clean host, record a
      baseline and post-completion counts while running sequential agent cycles.
      Completion evidence: a retained time series and descriptor-type
      classification show whether counts return near baseline or accumulate.
- [ ] Distinguish intentional live-session retention from orphaned helpers or a
      cleanup defect. Next action: correlate logical session state and terminal
      events with process ancestry, process-start identity, open pipes, sockets,
      and session JSONL handles. Completion evidence: every retained helper in
      the sample is classified as live/required, pending cleanup, or orphaned,
      with an independently checked causal conclusion.
- [ ] Implement the smallest measured local-runtime remediation without
      disguising a leak by only raising limits. Next action: use the lifecycle
      result to add cleanup, bounded concurrency/backpressure, supervision, or
      a justified soft-limit change to the local adapter. Completion evidence:
      the change has a rollback path, targeted tests, and no effect on the
      production gateway boundary.
- [ ] Validate the remediation under controlled concurrency. Next action:
      repeat clean-host runs at concurrency 1, 2, 4, 8, and 16 while recording
      peak and settled descriptor, child-process, and session-handle counts.
      Completion evidence: independent verification shows completed cycles
      settle near baseline, the configured concurrency stays below measured
      limits, and no `EMFILE`, disconnected evaluator, or transcript-save
      failure occurs.
