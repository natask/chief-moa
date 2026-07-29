## ADDED Requirements

### Requirement: Onboarding reaches a useful verified conversation first
Ag SHALL establish account continuity and one real, visibly successful voice
conversation using the minimum required Android access before offering broader
optional capabilities.

#### Scenario: New user completes the initial path
- **WHEN** the user launches Ag for the first time
- **THEN** Ag introduces itself as a personal AI companion
- **AND** connects or creates the user's account
- **AND** requests microphone access with an in-context explanation
- **AND** completes and verifies one real conversation
- **AND** offers notification access for continuity
- **AND** does not require optional phone-control capabilities to finish

### Requirement: Ag guides each capability without self-granting authority
For each optional capability, Ag SHALL explain the benefit, open the narrowest
Android-owned approval or settings surface, detect the user's return, inspect
actual state, and demonstrate the capability only after verification. Ag SHALL
NOT claim it granted its own permission.

#### Scenario: User enables an optional capability
- **WHEN** the user accepts an overlay, invocation-role, accessibility, browser,
  integration, or update capability step
- **THEN** Android opens the relevant system-owned prompt or settings page
- **AND** Ag verifies the resulting state when the user returns
- **AND** Ag visibly demonstrates only the newly verified capability

#### Scenario: User declines or Android blocks the capability
- **WHEN** the user declines, leaves the setting disabled, or Android prevents
  enablement
- **THEN** Ag reports the actual declined or blocked state
- **AND** offers a specific retry or later path
- **AND** does not block unrelated core use

### Requirement: Onboarding is progressive, resumable, and truthful
Optional capability setup SHALL be deferrable and later discoverable. Progress
SHALL survive interruption, but live Android state SHALL override cached setup
state. Server/model output SHALL remain a proposal and SHALL NOT satisfy local
permission, execution, or verification requirements.

#### Scenario: Setup is interrupted
- **WHEN** the process or device stops during onboarding
- **THEN** Ag resumes at the first incomplete relevant capability
- **AND** rechecks account and Android state before showing success

#### Scenario: Permission is revoked after onboarding
- **WHEN** a previously enabled Android permission or role is later revoked
- **THEN** Ag reports the capability as unavailable
- **AND** guides re-enablement only when the user requests or needs it

### Requirement: Relationship language preserves user autonomy
Ag SHALL build familiarity through reliable continuity, user-controlled memory,
clear explanations, and respect for choices. It SHALL NOT use guilt,
exclusivity, dependency cues, simulated friendship, pet-care mechanics, or
deceptive claims of personhood to drive engagement or permission grants.

#### Scenario: User skips relationship or capability customization
- **WHEN** the user declines personalization or an optional capability
- **THEN** Ag accepts the choice without pressure or degraded unrelated service
- **AND** keeps the option available for an explicit later decision
