# Quiet companion controls

## ADDED Requirements

### Requirement: The companion keeps two quick actions reachable

The browser companion MUST keep Copy and voice reply on/off reachable while the text panel is closed. It MUST NOT add account, history, settings, recording, or run controls to this quick surface.

#### Scenario: The user works with the panel closed

- **WHEN** the companion is visible and the text panel is closed
- **THEN** Copy and voice reply on/off remain reachable beside the companion
- **AND** no other quick action is present

### Requirement: Copy uses the latest bounded turn text

Copy MUST write the latest spoken transcript when it exists. It MUST fall back to the latest assistant reply when no spoken transcript exists. It MUST report when neither value exists.

#### Scenario: The latest turn has a transcript

- **WHEN** the user presses Copy after a spoken turn
- **THEN** the browser writes the full retained transcript to the clipboard without opening the panel

#### Scenario: No text exists

- **WHEN** the user presses Copy before any retained transcript or reply exists
- **THEN** the companion reports `Nothing to copy`
- **AND** the browser does not write an empty clipboard value

### Requirement: Voice off has immediate local authority

Turning voice replies off MUST stop scheduled local assistant playback before any gateway response. Later assistant audio frames MUST remain silent while text and run processing continue. This control MUST NOT cancel an agent run.

#### Scenario: The assistant is speaking

- **WHEN** the user turns voice replies off
- **THEN** the browser stops all scheduled assistant playback at once
- **AND** later audio frames for the active turn do not play
- **AND** assistant text may continue to stream

### Requirement: The voice choice survives reinjection

The browser MUST store the voice reply choice in extension-local storage and restore it when the companion is injected again.

#### Scenario: A muted user opens another page

- **WHEN** the user turned voice replies off on a prior page
- **THEN** the companion restores voice replies as off
- **AND** it does not call the gateway to restore the choice
