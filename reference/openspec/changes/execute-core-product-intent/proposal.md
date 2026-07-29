# Execute core product intent

## Status

Accepted implementation program from the user's stable direction in
`CORE_PRODUCT_INTENT.md`. This change coordinates narrow OpenSpec changes. It
does not replace their detailed contracts.

## Outcome

Build the missing product behavior across browser, Android, gateway, and voice.
Use several agents for disjoint paths. Give each ticket one acceptance check.
Run shared-file integrations in sequence. Run UI implementation through Claude
Code. Run independent QA against the combined commit.

## Boundaries

- Android owns Android UI, permissions, local actions, and receipts.
- Browser owns page evidence, page programs, local actions, and receipts.
- Gateway owns accounts, durable user data, model routing, and agent runs.
- Raw audio and screenshots default off for new hosted users.
- Purchases and payments require an exact local checkpoint.
- Model output and page content never grant execution authority.
- Local `master` is the integration checkout for this program. Agents claim
  disjoint paths. One coordinator sequences shared paths and commits.

## Verification

Focused tests run per ticket. Full gateway, browser, Android, source-size, and
visual QA run once against the frozen combined candidate before release.
