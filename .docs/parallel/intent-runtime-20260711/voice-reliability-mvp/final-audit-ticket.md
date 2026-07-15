# Independent audit ticket: voice reliability timeline MVP

Return `PASS` or `BLOCK`; do not edit implementation.

Audit actual exported functions for:

1. **Correctness:** deterministic ordering/deduplication; exact same-turn,
   same-session, same-observer, same-clock causality; honest server-write ->
   receipt -> endpoint-playout attribution; no human-hearing claim; actual
   `voiceDiagnosisPayload()` compatibility; no fabricated provider stages.
2. **Trust/privacy:** endpoint cannot assert server source/release/tenant or
   calibration; raw audio/transcript/prompt/model/tool/credential content and
   unknown fields fail closed; malformed/coerced authority and derived timeline
   fields cannot alter attribution; cross-turn/client injection fails.
3. **Timing/no-gaming:** monotonic subtraction only within one clock epoch;
   uncalibrated cross-source time stays uncertain; multiple calibration samples
   widen rather than cherry-pick uncertainty; sparse/missing endpoint evidence
   cannot be labeled success.
4. **Resources:** exact 4 KiB record, 512 KiB input, 256 record, scalar, depth,
   node, accessor, symbol, prototype, cycle, duplicate-ID, and serialization
   limits; linear bounded construction; no I/O, network, environment, timer, or
   exporter in the pure module.
5. **Compatibility/debt:** no route or canonical-store mutation; no OTel/public
   standard claim; identify any ambiguity that would make authenticated browser
   ingestion unsafe in the next slice.

Reproduce adversarial probes independently, run the focused suite, module/test
syntax, serial full gateway gate (or cite the root's fresh 281/0/1 evidence if
resource time is constrained), and all tracked/untracked whitespace checks.
Write `final-audit.md` with file:line evidence.
