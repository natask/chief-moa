# Cross-surface visual QA

Validate and print the planned state/reference inventory without capturing a
screen, calling a model, or changing either application:

```sh
node scripts/visual-qa/plan.mjs \
  --manifest scripts/visual-qa/visual-qa.example.json
```

The example deliberately reports the currently absent `gemini_images` path as
`missing_reference`. Copy it to a run-specific, ignored artifact directory and
replace candidate/artifact digests before a real run. The capture adapters and
Claude Code critique runner remain implementation tasks in the associated
OpenSpec change; this coordinator does not pretend they ran.
