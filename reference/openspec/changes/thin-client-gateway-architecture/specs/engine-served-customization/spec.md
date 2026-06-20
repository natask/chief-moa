## ADDED Requirements

### Requirement: Customizations are engine-served, not repackaged
User customizations and "deployments" SHALL travel from the engine to the client
as data (a declarative UI spec) and, for behavior beyond that vocabulary, as
sandboxed or explicitly opt-in generated scripts. They SHALL NOT require shipping
new extension package code.

#### Scenario: Declarative customization round-trip
- **WHEN** the user changes their UI (e.g. "add a button that summarizes the page") and the engine updates the per-user spec
- **THEN** the client re-fetches and re-renders the change live, with the extension package unchanged

#### Scenario: Generated page-acting code is sandboxed and opt-in
- **WHEN** a customization requires generated code that acts on the page
- **THEN** it runs through the `userScripts` sandbox behind the explicit per-extension opt-in, and is inspectable before it runs

### Requirement: Generated surfaces stay inspectable
Engine-generated UI and scripts SHALL be inspectable by the user before they take
effect, and SHALL run in a sandbox that cannot reach the extension's privileged
APIs except through a brokered channel.

#### Scenario: Sandboxed generated UI
- **WHEN** the engine serves a generated rich surface
- **THEN** it renders in a sandboxed context and communicates with the extension only through a brokered message channel, never with direct privileged access
