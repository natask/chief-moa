# Source Size Governance

## ADDED Requirements

### Requirement: Oversized production sources have non-growth ceilings

The repository SHALL reject a new production source above 2,000 lines and
SHALL reject growth beyond the recorded ceiling of any existing oversized
source while reporting the total production size as a trend metric.

#### Scenario: an oversized file grows

- GIVEN a production source has an explicit legacy ceiling
- WHEN its tracked line count exceeds that ceiling
- THEN the source-size quality gate fails.

