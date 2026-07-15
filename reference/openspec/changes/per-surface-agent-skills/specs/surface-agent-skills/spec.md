# Per-Surface Agent Skills

## ADDED Requirements

### Requirement: Skill availability respects the executing surface

The gateway SHALL resolve a turn's initiating surface and expose only bounded
skills whose execution authority is owned by an available client, while browser
and phone evidence remains non-executable context.

#### Scenario: browser task is delegated

- GIVEN a browser-origin turn requests a multi-step page task
- WHEN the gateway creates a browser agent task
- THEN the extension alone claims and executes allowlisted declarative actions
- AND the gateway records proposal, observation, and receipt state.

