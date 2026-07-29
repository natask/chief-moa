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

### Requirement: A tap expands the bounded ribbon to reveal the whole turn
A ribbon SHALL open on tap to show the full text of the current turn, bounded in
height, with its copy affordance reachable in that state. A second tap closes it.
Expansion is the only thing that may change the unit's height.

#### Scenario: Reading past the sliding window
- **WHEN** the user taps a ribbon whose text has scrolled past its viewport
- **THEN** the ribbon expands in place, wraps the full retained text, and shows
  the copy affordance

#### Scenario: The expansion is bounded
- **WHEN** the turn is far longer than the expanded ceiling
- **THEN** the ribbon stops growing at that ceiling and shows the tail, and the
  unit does not become a panel

#### Scenario: Streaming may still not resize anything
- **WHEN** a delta arrives while the ribbon is collapsed
- **THEN** no element's width, height, or position changes

#### Scenario: Closing
- **WHEN** the user taps the expanded ribbon again, or the turn's text is cleared
- **THEN** the ribbon collapses back to its one-line footprint

### Requirement: Copy offers the literal, corrected, and polished forms
Copy SHALL expose three variants of the user's own transcript. The polished form
SHALL be the default copy when it exists, and the literal transcript SHALL never
be overwritten by a derived one.

#### Scenario: Only the literal transcript exists
- **WHEN** no corrected or polished form has been produced
- **THEN** copy takes the literal transcript, and the absent forms are shown
  disabled rather than fabricated

#### Scenario: A polished form exists
- **WHEN** a writing skill has produced a polished form
- **THEN** a plain copy takes the polished form and the literal transcript is
  still offered and still byte-for-byte unchanged

#### Scenario: Choosing a variant
- **WHEN** the user picks a named variant from the hold menu
- **THEN** exactly that form reaches the clipboard

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

### Requirement: Hands-free capture is bounded
Continuous capture SHALL re-arm the microphone after every turn with no new gesture.
That loop SHALL end on its own, both when it stops hearing speech and when it
has simply run long enough, and leaving it SHALL release the microphone.

#### Scenario: The phone is set down
- **WHEN** consecutive re-armed turns produce no real transcript
- **THEN** the loop ends, the warm microphone and any live capture session are
  released, and the overlay says listening stopped

#### Scenario: The session simply runs long
- **WHEN** the loop has been armed for the maximum session duration
- **THEN** it ends regardless of how much speech there has been

#### Scenario: The user is still talking
- **WHEN** turns keep producing real transcripts inside the session cap
- **THEN** the loop continues, and a single spoken turn resets the silence count

#### Scenario: Leaving is not a lockout
- **WHEN** the loop has ended on either bound
- **THEN** the visible state matches reality — nothing looks armed that is not —
  and the normal gesture re-arms capture immediately with a fresh budget
