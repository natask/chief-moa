## ADDED Requirements

### Requirement: Browser memory is explicit and local
The extension SHALL keep selective browser memory off by default and SHALL write
cards only after a user enables it from an extension-owned surface. Creating,
viewing, pausing, or erasing cards SHALL make no gateway or model request.

#### Scenario: Fresh extension visits pages
- **WHEN** Browser memory has not been enabled
- **THEN** no semantic page card is written

#### Scenario: User enables Browser memory
- **WHEN** the user activates the panel control on a normal visible HTTP(S) page
- **THEN** the extension may retain one locally visible bounded card
- **AND** the panel visibly reports that memory is on

### Requirement: Retained information is bounded and inspectable
A memory card SHALL contain only a query-free/hash-free URL, hostname, title,
first primary heading, publisher meta description, structural page kind,
first/last seen time, and visit count. Every text field and the collection SHALL
be bounded. The collection SHALL expire entries after 30 days and retain at most
100 cards.

#### Scenario: URL contains private parameters
- **WHEN** an eligible page URL contains a query or fragment
- **THEN** neither the query nor fragment is persisted

#### Scenario: User revisits an unchanged page
- **WHEN** the proposed card exactly matches a retained card
- **THEN** the extension increments visit count and last-seen time
- **AND** does not append another duplicate

### Requirement: Broad page capture is excluded
The memory collector SHALL NOT read or retain screenshots, video, audio, OCR,
body text, selections, accessibility data, form/control values, cookies, browser
history, or another application's content.

#### Scenario: Page contains an editable form
- **WHEN** a normal page is eligible for memory
- **THEN** the collector does not read any form or control value

### Requirement: Recognized sensitive pages are suppressed
The collector SHALL apply the existing bounded sensitive-route, password,
credential/payment autocomplete, and form-metadata checks before reading
semantic memory fields. It SHALL NOT claim universal sensitive-page detection.

#### Scenario: Password page becomes active
- **WHEN** a recognized password or credential marker is present
- **THEN** no memory candidate is produced or stored

### Requirement: User can stop and erase retention
The panel SHALL expose separate pause and erase controls. Pause SHALL prevent
future capture without deleting cards; Erase SHALL delete all cards without
silently changing the enabled preference.

#### Scenario: User erases while memory is on
- **WHEN** the user activates Erase
- **THEN** the visible and persisted card list becomes empty
- **AND** the enabled preference remains on
