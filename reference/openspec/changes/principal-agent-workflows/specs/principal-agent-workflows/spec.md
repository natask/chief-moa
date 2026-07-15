# Principal Agent Workflow Profiles

## ADDED Requirements

### Requirement: Explicit principal intent selects a checked-in workflow

The broker SHALL deterministically select the checked-in `security`,
`simplification`, or `fuzzing` workflow profile when a spoken transcript or
typed broker event explicitly requests that role. These role-specific matches
SHALL take precedence over generic QA and coding matches.

#### Scenario: Spoken security audit intent arrives

- **WHEN** a broker event explicitly asks for a security audit or vulnerability
  assessment
- **THEN** the broker emits an `invoke_workflow` decision for `security` with a
  context pack referencing the checked-in security workflow

#### Scenario: Role is selected without activation

- **WHEN** a principal intent does not explicitly request broker activation
- **THEN** the broker stores its decision and context pack but launches no run

### Requirement: Principal context packs preserve role boundaries

Every principal context pack SHALL identify its principal role, execution
policy, checked-in workflow directory and instruction file, role constraints,
expected output, verification checks, and any required repair handoff. These
fields SHALL grant no device, merge, deployment, or hidden execution authority.

#### Scenario: Security context pack is created

- **WHEN** the broker materializes a security context pack
- **THEN** the pack declares `audit_only`, prohibits self-repair, and requires a
  separate repair run plus independent re-verification

#### Scenario: Fuzzing context pack is created

- **WHEN** the broker materializes a fuzzing context pack
- **THEN** the pack requires isolated exact-candidate evidence, minimized and
  deduplicated findings, and bounded repair handoffs without candidate edits

#### Scenario: Simplification context pack is created

- **WHEN** the broker materializes a simplification context pack
- **THEN** the pack permits editing, testing, and committing one isolated
  behavior-preserving candidate and requires before/after evidence
- **AND** it prohibits weakened checks, self-acceptance, merge, deployment,
  promotion, publication, master push, and active deployment mutation
- **AND** it hands the commit and unchanged checks to a separate independent
  verifier before coordinator-owned integration

### Requirement: First-slice activation launches one principal run

The broker SHALL use its existing explicit activation path and SHALL start at
most one selected principal as a non-blocking agent run. This slice SHALL NOT
schedule recurring runs, concurrently launch multiple principals, or launch
automatic repairs.

#### Scenario: Explicit principal activation arrives

- **WHEN** a broker request selects a principal and explicitly asks to launch
- **THEN** exactly one `wait=false` run is linked to the selected decision and
  its stored context pack

#### Scenario: Principal reports a finding

- **WHEN** security or fuzzing produces a repair handoff
- **THEN** the first-slice broker launches no repair run automatically
