## ADDED Requirements

### Requirement: The shared checkout stays on master

The system SHALL treat the primary ChiefMoa checkout as a shared workspace and
SHALL refuse an agent launch there when its current branch is not `master`,
unless the launch identifies the exact alternate branch and durable evidence of
the user's explicit request.

#### Scenario: Agent launch finds an unrelated branch

- **WHEN** Claude Code or Codex is launched in the primary checkout on a branch
  other than `master` without explicit exception evidence
- **THEN** the launcher refuses to start the provider and names isolated
  worktree use as the safe path

### Requirement: Branch work is isolated

The system SHALL deny known checkout-changing Git commands aimed at the primary
checkout from Claude Code and Codex tool calls and SHALL allow those commands in
a linked worktree.

#### Scenario: Agent proposes a branch switch in the shared checkout

- **WHEN** a provider shell tool proposes `git switch`, `git checkout`, or a
  direct `HEAD` rewrite against the primary checkout
- **THEN** the pre-tool hook denies the command before Git runs

#### Scenario: Agent switches a linked worktree

- **WHEN** a provider shell tool changes branches inside an isolated linked
  worktree
- **THEN** the guard allows it and the primary checkout branch and commit stay
  unchanged

### Requirement: Violations are observable

The system SHALL inspect the primary branch at session start and after shell
tools and SHALL report any branch other than `master` without automatically
rewriting the checkout.

#### Scenario: An unrecognized command changes the shared branch

- **WHEN** the post-tool check finds that the primary checkout is no longer on
  `master`
- **THEN** the provider receives a blocking violation that names the actual and
  required branches
