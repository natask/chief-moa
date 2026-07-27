## ADDED Requirements

### Requirement: A recording-active signal is tied to microphone hardware state, not UI state
Every surface that can open the microphone SHALL render a recording-active
signal for exactly the duration the microphone hardware is open, independent
of which turn/panel/ribbon visibility state the rest of the overlay is in.

#### Scenario: Continuous-loop re-arm without a new gesture stays visible
- **WHEN** Android's continuous voice loop re-arms the microphone after a turn
  ends, with no new tap or hold from the user
- **THEN** the recording-active signal turns on at the moment the microphone
  hardware opens, not only at the moment of the original tap that entered the
  loop

#### Scenario: Signal follows the hardware, not the dismissal path
- **WHEN** the microphone hardware stream closes for any reason (turn end,
  cancel, error, loop exit)
- **THEN** the recording-active signal turns off in the same step, with no
  separate user action required to clear it

#### Scenario: Silent pre-roll still counts as recording-active
- **WHEN** the microphone is warmed (pre-roll buffering) before a hold gesture
  is confirmed as an intentional capture
- **THEN** the recording-active signal is already on, because audio hardware
  is already capturing

### Requirement: The recording-active signal survives every overlay opacity state
The recording-active signal SHALL remain visible at no less than 0.7 opacity
on the companion element in every overlay state, including the ribbon
redesign's `dormant` state where ribbons themselves render at zero opacity.

#### Scenario: Dormant overlay, active microphone
- **WHEN** the overlay unit is in `dormant` state (no recent text, no pointer
  nearby) and the microphone hardware is open
- **THEN** the companion's recording-active visual renders at no less than 0.7
  opacity, even though the ribbons remain hidden per the `dormant` contract

#### Scenario: Reduced transparency and recording-active both apply
- **WHEN** `prefers-reduced-transparency` (or Android's high-text-contrast
  equivalent) is active at the same time as recording-active
- **THEN** both sanctioned occluding/high-visibility states apply together;
  neither is suppressed by the other

### Requirement: The recording-active visual does not alter the ribbon redesign's visibility contract
Recording-active state changes SHALL be limited to the companion element's own
rendering. It SHALL NOT add a plate, blur, resize, or reposition any ribbon,
and SHALL NOT change the companion's existing `avatar_behavior` motion set.

#### Scenario: Recording during an ambient ribbon
- **WHEN** a ribbon is in `ambient` state (streaming text, no plate) while
  recording-active is also true
- **THEN** the ribbon keeps its existing halo/scrim ambient rendering unchanged
  and only the companion carries the additional recording-active visual

### Requirement: Browser recording state is visible even when the in-page overlay is not
The browser extension SHALL expose a toolbar-level (`chrome.action`) recording
indicator that reflects the same microphone-hardware-open signal as the
in-page indicator, independent of whether any tab currently has the overlay
injected, visible, or scrolled into view.

#### Scenario: Capture continues after the overlay tab loses view
- **WHEN** voice capture is active and the user switches to a tab where the
  overlay was never injected, or scrolls the overlay out of view
- **THEN** the extension's toolbar icon shows a recording badge for as long as
  the microphone hardware remains open

#### Scenario: Toolbar badge clears with hardware state
- **WHEN** the microphone hardware stream closes
- **THEN** the toolbar badge clears in the same step, matching the in-page
  indicator's timing

### Requirement: The recording-active visual is itself the stop control
Tapping or clicking the companion while recording-active is true SHALL stop
capture immediately, using the existing capture-toggle gesture contract, at no
less than the existing minimum hit-target size, regardless of the companion's
current opacity state.

#### Scenario: Stop from a dim companion
- **WHEN** the companion is rendering at `dormant` opacity for its base state
  but shows the recording-active visual per the opacity floor above
- **THEN** the tappable/clickable area for stopping capture is unchanged from
  the existing gesture contract's hit-target size, not reduced to match the
  dimmer visual

#### Scenario: No new gesture is introduced
- **WHEN** a user stops an active capture through the recording-active visual
- **THEN** the action taken is the existing tap-to-toggle-capture gesture
  already defined for the companion; no new gesture, menu, or control is added

### Requirement: A capture block can be deleted after the fact
The gateway SHALL provide a token-protected `DELETE /v1/capture-blocks/:id`
route, scoped to the block's owning session, using tombstone semantics: the
block stops appearing in list, search, and detail reads and any pending
routing proposal on it is cancelled, without requiring an immediate purge of
the underlying stored audio or record.

#### Scenario: Deleted block disappears from reads
- **WHEN** a capture block is deleted by its owning session's token
- **THEN** subsequent `GET /v1/capture-blocks`, `/search`, and `/:id` calls no
  longer include or resolve that block

#### Scenario: Deletion does not require purging bytes immediately
- **WHEN** a capture block is deleted
- **THEN** the underlying audio bytes may remain under the existing storage
  and retention policy rather than being purged synchronously, so the
  existing recovery reconciliation path is not required to change

#### Scenario: Cross-session deletion is rejected
- **WHEN** a delete request is made with a token that does not own the target
  capture block's session
- **THEN** the gateway rejects the request and the block is not affected

### Requirement: Each surface offers one-tap review-and-delete of the capture that just ended
After capture stops, the next interaction with the recording-active companion
element SHALL surface the literal transcript (if any) of the capture block
that just ended and a Delete action bound to the route above, scoped to that
one most-recent block.

#### Scenario: Review immediately after stopping
- **WHEN** the user stops a capture via the recording-active companion
- **THEN** the very next tap on the companion (or an explicit review
  affordance shown at that moment) shows that capture's literal transcript and
  a Delete action, before any other action is available from that element

#### Scenario: Delete removes it from the review surface
- **WHEN** the user selects Delete from the review affordance
- **THEN** the capture block is deleted per the route above and the review
  affordance reflects that it is gone

#### Scenario: This is not a history browser
- **WHEN** the user has more than one recent capture block
- **THEN** the review affordance reached from the recording-active companion
  shows only the single most-recent block, and does not offer navigation to
  older blocks; browsing older captures remains the separate notebook/history
  surface's scope
