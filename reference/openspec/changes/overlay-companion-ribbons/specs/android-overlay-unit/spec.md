## ADDED Requirements

### Requirement: The overlay never occludes more than its resting footprint
The overlay unit SHALL hold a fixed footprint of two single-line ribbons, one
gap each, and the companion. No text, stream delta, reply length, or turn count
may change any element's width, height, or position.

#### Scenario: A long reply streams in
- **WHEN** assistant text arrives that is wider than the ribbon viewport
- **THEN** the ribbon's viewport keeps its width and its 28dp height, the line
  slides left so the newest glyph stays at the right inner edge, and the
  companion does not move

#### Scenario: A turn ends and another begins
- **WHEN** consecutive turns complete
- **THEN** the unit's height is unchanged, no row is appended, and no surface
  grows or scrolls

#### Scenario: System font scale is very large
- **WHEN** the system font scale exceeds 1.3
- **THEN** the ribbon takes one step to 32dp, the text size clamps at 1.3, and
  the ribbon does not wrap or grow further

### Requirement: The rendered text is a grapheme-safe tail window
Each ribbon SHALL retain at most 8,000 grapheme clusters per turn and render at
most the last 140, never splitting a cluster.

#### Scenario: Text exceeds the retention bound
- **WHEN** a turn's text passes 8,000 clusters
- **THEN** clusters are dropped from the FRONT, the newest text survives, and the
  buffer is marked truncated

#### Scenario: Copying
- **WHEN** the user copies from a ribbon
- **THEN** the clipboard receives the full retained buffer, not the visible window

#### Scenario: Multi-code-point scripts
- **WHEN** the text ends in Ethiopic, a Devanagari conjunct, an emoji, or a
  combining sequence
- **THEN** truncation falls on a cluster boundary and no broken glyph is pinned
  at the ribbon's edge

### Requirement: Nothing paints a filled plate unless the user is touching it
The unit SHALL hold one of dormant, ambient, engaged, or dragging. Only engaged
and dragging paint a plate, and both require a finger on the unit.

#### Scenario: Idle
- **WHEN** no turn is live and no linger is running
- **THEN** the ribbons are invisible and take no touch, and the companion sits at
  0.18 opacity

#### Scenario: A turn is streaming
- **WHEN** transcript or reply text is arriving
- **THEN** the ribbons show glyphs with a halo and a scrim that hugs the text run,
  paint no plate, and an empty ribbon paints nothing at all

#### Scenario: The user presses a ribbon
- **WHEN** a finger lands on the painted glyph run
- **THEN** the ribbon solidifies inside its existing box, the copy rail appears,
  and the state latches for 6s after release

#### Scenario: Reduced transparency is requested
- **WHEN** the system reports high text contrast
- **THEN** ambient uses the engaged plate at 0.86 instead of the halo, and this
  is the only sanctioned occluding ambient

### Requirement: The unit moves as one object from any element
Every element of the unit SHALL be a drag handle, and every drag SHALL translate
the companion anchor with both ribbons following in the same frame.

#### Scenario: Dragging from a ribbon
- **WHEN** the user drags a ribbon past the touch slop
- **THEN** the pending tap and hold are cancelled, the companion anchor moves,
  and both ribbons move by the same delta

#### Scenario: Not enough room above
- **WHEN** the companion sits too high for the you-ribbon to fit above it
- **THEN** both ribbons flip below the companion in you-then-reply order and the
  companion does not move

#### Scenario: Release
- **WHEN** the drag ends
- **THEN** the unit settles exactly where it was placed, clamped only by the edge
  margin, and never snaps to a screen edge

### Requirement: The remove target is bounded and its removal is reversible
Drag-to-remove SHALL arm only when the companion's centre is over the painted
target plus one small tolerance, and a completed removal SHALL be undoable.

#### Scenario: A drag passes near the bottom of the screen
- **WHEN** the companion is dragged along the bottom edge but not onto the target
- **THEN** removal does not arm

#### Scenario: Dropping on the target
- **WHEN** the companion is released on the armed target
- **THEN** every overlay window detaches in the same frame and an undo affordance
  remains for five seconds

#### Scenario: Taking the undo
- **WHEN** the user taps undo inside that window
- **THEN** the companion returns to the position the drag STARTED from, and the
  service is not stopped

#### Scenario: Ignoring the undo
- **WHEN** the window closes untouched
- **THEN** the overlay service stops

### Requirement: The overlay opens history, it does not become history
Double-tapping a ribbon SHALL open the full app's history surface. The overlay
SHALL never render a scrollback.

#### Scenario: Double tap
- **WHEN** the user double-taps either ribbon
- **THEN** the ribbon flashes an acknowledgement, the full app opens scrolled to
  shared history, and the overlay stays alive behind it

### Requirement: The overlay exposes no settings entry point
No overlay surface SHALL offer a route to settings, modes, or profile changes.

#### Scenario: The hold menu
- **WHEN** the user holds a ribbon
- **THEN** at most four rows appear, none of which takes a model action, launches
  a run, or changes a setting
