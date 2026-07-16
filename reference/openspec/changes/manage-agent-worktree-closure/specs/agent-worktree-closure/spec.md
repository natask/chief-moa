## ADDED Requirements

### Requirement: Work state is independent of worktree existence

The system SHALL treat Git worktrees as disposable execution contexts and
SHALL represent accepted work through durable commit, specification,
verification, deployment, and closure evidence.

#### Scenario: Archived worktree is inspected later

- **WHEN** a closed task needs to be inspected after its worktree was removed
- **THEN** its retained commit or branch identity and closure receipt identify
  the exact historical candidate without requiring the old directory

### Requirement: Worktree audit is non-mutating by default

The lifecycle command SHALL classify registered worktrees without removing a
directory, pruning metadata, deleting a ref, or changing a candidate unless an
explicit execution flag is supplied to the archive command.

#### Scenario: User audits accumulated worktrees

- **WHEN** the user runs the default audit command
- **THEN** every registered worktree is classified and repository state is
  unchanged

### Requirement: Automatic closure fails safe

The lifecycle command SHALL automatically remove only a non-primary,
non-invoking, unused, clean worktree whose HEAD is contained in or
patch-equivalent to the selected target commit.

#### Scenario: Dirty candidate is encountered

- **WHEN** a registered worktree has tracked or untracked changes
- **THEN** it is classified as dirty and remains untouched

#### Scenario: Unique candidate is encountered

- **WHEN** a clean worktree contains a commit with a patch not present in the
  selected target
- **THEN** it is classified as unique and remains untouched

#### Scenario: Running process uses an otherwise safe worktree

- **WHEN** a running process has the worktree or one of its descendants as its
  current working directory
- **THEN** the worktree is classified as in-use and remains untouched

#### Scenario: Promoted clean worktree is closed

- **WHEN** explicit archive execution is requested for a clean, unused
  worktree already represented in the selected target
- **THEN** the command records its exact closure evidence before removing the
  execution directory and preserves its branch ref

### Requirement: Closure evidence identifies the promoted target

Every automatic closure receipt SHALL include timestamp, worktree path, branch
or detached state, exact HEAD, classification, target ref, and resolved target
SHA. Repeated cleanup SHALL NOT append another receipt for the same worktree
path, HEAD, classification, and resolved target SHA.

#### Scenario: Closure decision is audited

- **WHEN** an operator reviews a closure receipt
- **THEN** the receipt identifies both the removed execution context and the
  exact promoted target that justified removal

#### Scenario: Cleanup is repeated after an interrupted prune

- **WHEN** a prior pass recorded closure but Git still reports the registration
- **THEN** the next pass may finish pruning it without appending a duplicate
  receipt for the same target
