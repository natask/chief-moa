## ADDED Requirements

### Requirement: Extension is a thin client
The browser extension SHALL act as a thin client: it renders surfaces from
engine-served specs, captures text/voice input, and brokers page access for the
engine. It SHALL NOT hold API keys or subscriptions, and SHALL NOT be the unit
into which a user deploys customizations.

#### Scenario: No secrets in the browser
- **WHEN** the extension needs to make a model/API call
- **THEN** it calls its configured engine with a session token, and the API keys/subscriptions used for the call live on the engine, not in the extension

#### Scenario: Renders engine-served surfaces
- **WHEN** the engine serves an updated UI spec for the user
- **THEN** the extension renderer reflects it without repackaging or reinstalling the extension

### Requirement: Stable extension package
The extension package SHALL change rarely and SHALL NOT be the channel for
user-specific customization, consistent with MV3's ban on remotely-hosted
executable code in the privileged context.

#### Scenario: Customization does not repackage the extension
- **WHEN** a user customizes their UI or behavior
- **THEN** the change is delivered by the engine as data or sandboxed/opt-in script, and the installed extension package is unchanged
