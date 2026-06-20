## ADDED Requirements

### Requirement: Extensible extension interface
The extension's interface SHALL be able to gain new elements and displays driven
by the user, not only by a code rebuild. The extension package SHALL remain a
stable thin client; new interface structure SHALL be delivered by the engine as
a declarative UI spec by default, with sandboxed rich surfaces or explicitly
opted-in `userScripts` for generated behavior beyond the declarative vocabulary.

#### Scenario: New UI element appears
- **WHEN** the user adds or enables a new interface element through the (to-be-designed) mechanism
- **THEN** the engine updates the user's declarative UI spec and the stable extension renderer displays the new element without repackaging the extension

#### Scenario: Generated behavior is sandboxed or opt-in
- **WHEN** a customization requires generated behavior beyond the declarative UI spec
- **THEN** rich UI runs in a sandboxed surface, and page-acting scripts require explicit `userScripts` opt-in plus inspection before execution
