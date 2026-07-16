# Source Size Governance

## ADDED Requirements

### Requirement: Oversized production sources have non-growth ceilings

The repository SHALL reject a new production or UI source above 2,000 lines,
SHALL reject growth beyond the recorded ceiling of any existing oversized
source, and SHALL reject growth beyond the recorded repository-wide production
and UI debt ceiling. The repository ceiling SHALL ratchet downward during
migration and SHALL become a permanent 50,000-line maximum when it reaches the
final target.

#### Scenario: an oversized file grows

- GIVEN a production source has an explicit legacy ceiling
- WHEN its tracked line count exceeds that ceiling
- THEN the source-size quality gate fails.

#### Scenario: bounded files grow the repository total

- GIVEN every individual production and UI source is within its file ceiling
- WHEN their combined line count exceeds the recorded repository debt ceiling
- THEN the source-size quality gate fails.

#### Scenario: the final target is reached

- GIVEN the repository debt ceiling has been ratcheted to 50,000 lines
- WHEN production and UI source remains at or below 50,000 lines
- THEN the total-size quality gate passes.
