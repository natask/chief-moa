## ADDED Requirements

### Requirement: The overlay group moves and dismisses locally
The orb and the one open card SHALL remain an anchored group that can be moved
without opening the full app.

#### Scenario: Move from either surface
- **WHEN** the user drags the orb or a chat/voice card header
- **THEN** Android moves the shared anchor and keeps the entire card above the orb
  with a gap when it fits, otherwise wholly below it

#### Scenario: Close versus Hide
- **WHEN** the user selects Close on a voice/chat card
- **THEN** Android cancels the active draft/card locally and retains the orb
- **WHEN** the user selects Hide or drops the orb on Remove
- **THEN** Android stops the overlay service and removes every overlay window

### Requirement: Mobile styling matches the browser surface
Android SHALL use the browser's neutral near-black glass surfaces, amber/gold
accent, and violet user bubbles without a green cast.

#### Scenario: Overlay renders on another app
- **WHEN** the orb and chat or voice card are visible above another app
- **THEN** their surfaces use the neutral browser-aligned palette without a
  green-tinted panel gradient

### Requirement: Text selection has priority over row swipe
Transcript rows SHALL allow text selection and use equal left/right dismissal
only when selection is not active.

#### Scenario: Select before swiping
- **WHEN** text selection or Android action mode is active
- **THEN** horizontal movement does not translate or dismiss the row
- **WHEN** selection is cleared and either horizontal threshold is crossed
- **THEN** the same eligible row cascade is dismissed in either direction
