# Fixed-notch runtime QA — 2026-08-03

## Candidate

- Source commit: `645477dd` (`fix(macos): pin companion to physical notch`).
- QA archive: `apple_surfaces/dist/Ag-0.1.0-202608030701-arm64.zip`.
- Archive SHA-256: `21a50f6592e117190b54437278ab65cd067e1281d4414867ee9ca9abdffed498`.
- Installed executable SHA-256:
  `2ba79ad3e2a224146772a2d87940a89335d5c49eee4d4ef5f26b086712308564`.
- Installed target: `/Applications/Ag.app`.
- Previous installed app preserved at:
  `apple_surfaces/dist/rollback/Ag-installed-before-645477dd.app`.

Ag was not running when the candidate replaced the prior QA bundle. The staged
candidate passed strict ad-hoc code-sign verification before the transaction.
The installed target then passed the repository source/binary scan and matched
the packaged executable digest exactly.

## Physical-screen geometry

The installed app's no-network `--window-geometry-smoke` ran against the active
built-in 1728-by-1117-point notched display and reported:

```text
compact={{668, 1053}, {392, 64}}
expanded={{504, 597}, {720, 520}}
compact_again={{668, 1053}, {392, 64}}
stable=true
```

Every frame has physical top `1117` and center X `864`. Expansion opens only
after an explicit presentation event and grows downward from that invariant
anchor. Collapse returns to the exact compact frame. The production source has
no hover event that changes presentation geometry, no movable panel flag, no
saved-position restore, and no pointer-selected display path.

## Verification

- `cd apple_surfaces && swift test`: 92 tests passed.
- `cd apple_surfaces && swift build --product Ag`: passed.
- Offscreen compact and Agents workspace bitmap rendering: passed.
- `node scripts/source-size-policy.js`: passed.
- `openspec validate macos-clicky-parity-surface --strict`: passed.
- Packaged and installed app source/binary scan: passed.
- Packaged and installed app geometry smoke: passed.

## Remaining distribution boundary

This is an installed private QA artifact, not a production Mac release. It is
arm64 and ad-hoc signed. Developer ID signing, hardened runtime, notarization,
stapling, universal architecture, isolated TCC acceptance, and a supported
updater remain under task 4.4. Those distribution gates do not change the
verified fixed-notch behavior of this installed candidate.
