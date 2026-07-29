## 1. Vocabulary

- [x] 1.1 Record canonical Chief Moa, Aggie/A.G., Surface, Observation,
      Assistance Suggestion, Project, Workstream, Thread, Task, Work Node,
      Workflow, Run, Artifact, Proposal, Approval, and Receipt meanings.
- [x] 1.2 Record compatibility names and disambiguating verbs.
- [ ] 1.3 Normalize user-facing product copy opportunistically without bulk
      renaming persisted keys or unrelated packages. Next: update copy only in
      each touched surface slice. Complete when copy audits for all shipped
      surfaces find no conflicting user-facing terms and compatibility keys
      remain unchanged.

### 1A. Neutral terminology tournament progress

An item is complete only when its named evidence exists; research, a partial
evaluation, or a failed evaluator launch does not complete a later phase.

- [x] 1A.1 Generate unranked candidates independently for the user-facing
      surface and durable work-object layers, then add incumbent terms as
      falsifiable challengers. Evidence:
      [`terminology-tournament-evidence-20260725.md`](terminology-tournament-evidence-20260725.md).
- [ ] 1A.2 Complete one clean, rubric-identical user-facing-surface evaluation
      per surface candidate without exposing competing evaluations. Current
      evidence: the first eight
      user-surface evaluators disconnected without results; no failed launch is
      a negative evaluation. Next action: rerun failed evaluations in bounded
      sequential waves. Completion evidence: one retained evaluation for every
      surface candidate, with reruns labeled and failures recorded separately.
- [ ] 1A.3 Complete one clean, rubric-identical durable-work-object evaluation
      per durable-object candidate without exposing competing evaluations. Next
      action: run bounded clean-context waves with the same problem statement
      and rubric. Completion evidence: one retained evaluation exists for every
      durable-object candidate and failures are recorded separately.
- [ ] 1A.4 Run independent falsifiers after the neutral evaluations. Next
      action: give falsifiers the complete candidate evidence without asking
      them to preserve incumbents. Completion evidence: retained falsification
      findings cover every surviving candidate and identify unsupported claims.
- [ ] 1A.5 Use a fresh adjudicator to select terms independently for each layer.
      Next action: provide the blinded evaluations and falsifier findings to an
      adjudicator that did not generate or evaluate candidates. Completion
      evidence: a decision record applies the common rubric, explains each
      winner, and permits different winners by layer.
- [ ] 1A.6 Preserve a rejected-term ledger. Next action: record every eliminated
      neutral and incumbent term with the phase and evidence that eliminated
      it. Completion evidence: every non-winning candidate is traceable to a
      retained evaluation, falsification finding, or adjudication reason.

## 2. Suggestion promotion

- [x] 2.1 Ship the browser local-observation/suggestion lifecycle.
- [ ] 2.2 Add one inspectable suggestion-acceptance to broker-event mapping.
      Next: implement one disclosed suggestion type end to end. Complete when a
      smoke links one acceptance to exactly one broker event with stable
      provenance.
- [ ] 2.3 Prove dismissal/expiry never creates intent/task/run records. Next:
      add negative lifecycle tests. Complete when dismissal and expiry tests
      show zero broker events, tasks, or runs.

## 3. Project and Workstream state

- [ ] 3.1 Specify additive Project/Workstream events and projections, including
      parent-project compatibility and idempotent migration. Next: write the
      event, reducer, and migration contract. Complete when strict OpenSpec
      validation passes and compatibility examples cover replay and retry.
- [ ] 3.2 Link Threads and Tasks to Project/Workstream without changing identity.
      Next: add nullable relation fields and projection links. Complete when
      migration tests preserve existing Thread and Task IDs.
- [ ] 3.3 Add full-surface project views while keeping overlays bounded. Next:
      implement the first full-app Project/Workstream view without adding deep
      overlay navigation. Complete when surface QA proves linked Threads and
      Tasks are inspectable and overlays remain within their bounded contract.

## 4. Cross-surface verification

- [ ] 4.1 Prove one accepted intent is visible through shared Aggie session/events
      while local capabilities and approvals remain surface-owned. Next: run
      one cross-surface acceptance scenario. Complete when retained events show
      the same intent identity on two surfaces and local action approval stays
      with the executing surface.
