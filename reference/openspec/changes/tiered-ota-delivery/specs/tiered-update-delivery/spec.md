# Tiered Update Delivery

## ADDED Requirements

### Requirement: Dynamic layers and native packages use distinct update authority

The system SHALL treat declarative gateway-served layers as Tier 1 and native
packages as Tier 2, with versioned receipts and rollback appropriate to each
tier; an agent-requested Tier 1 move MUST NOT authorize a Tier 2 installation.

#### Scenario: user asks to restore an earlier persona

- GIVEN an earlier compatible profile-layer version exists
- WHEN the user approves that layer rollback
- THEN the gateway moves only the Tier 1 profile pointer and records a receipt
- AND the installed native package remains unchanged.

