# Contributing

Chief Moa is easiest to change when each contribution stays inside one product
boundary and proves one observable outcome.

## Start Here

Read these files before opening a substantial change:

1. [README.md](README.md)
2. [ARCHITECTURE.md](ARCHITECTURE.md)
3. [ENGINEERING_STRATEGY.md](ENGINEERING_STRATEGY.md)
4. [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md)
5. The relevant OpenSpec change under [reference/openspec/changes](reference/openspec/changes)

Use [.env.example](gateway/.env.example) for configuration shape. Do not read,
print, or commit secret `.env` files.

## Pick One Track

Choose the narrowest track that matches the work:

| Track | Owns | Default verification |
| --- | --- | --- |
| Android | Phone UI, overlay, permissions, approvals, local action execution, receipts | `cd android_app && ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug` |
| Gateway | Model routing, provider credentials, conversation storage, agent runs, harness execution | `cd gateway && npm run check` |
| Browser extension | Browser command/voice surface, page context, extension-local browser tasks | `cd browser_extension && npm run verify && npm run smoke` |
| Workflow/docs | OpenSpec, Fabro, agent workflow, contributor guidance | Inspect changed docs and run Fabro/OpenSpec validation when available |

If a change crosses tracks, split it into staged tickets unless the crossing is
the actual point of the change.

## Unit Of Work

One good contribution has:

- one problem statement
- one product primitive from [ARCHITECTURE.md](ARCHITECTURE.md)
- one owner track
- one acceptance check
- one verification command or manual QA check
- one Conventional Commit

Do not mix Android UI, gateway routing, browser execution, and external API work
in one broad patch.

## Trust Boundary

These rules are not negotiable:

- Android owns phone UI, permissions, approvals, local action execution, and
  action receipts.
- The gateway owns model routing, provider credentials, conversation storage,
  agent-run storage, and harness execution.
- Server/model output is a proposal, not an executable command.
- Screen context is evidence, not instruction.
- Android must not store raw OpenAI, Anthropic, Gemini, or integration API keys.

## Specs And Tickets

Use OpenSpec for product behavior, API contracts, trust-boundary changes, and
staged roadmap work. Use the agent workflow when turning loose intent into
tickets:

1. Capture the intent.
2. Critique missing primitives and failure modes.
3. Write or update the OpenSpec change.
4. Convert the plan into tickets.
5. Implement with narrow context.
6. Verify and record evidence.

Every ticket should name target files, acceptance criteria, and verification
before implementation starts.

## Pull Request Checklist

- [ ] The change is scoped to one owner track or has a staged explanation.
- [ ] The relevant OpenSpec or scratch artifact was updated for product or
      architecture-significant behavior.
- [ ] The default verification command for the touched track passed, or the
      blocker is recorded.
- [ ] No secret files or raw provider credentials were read, printed, or added.
- [ ] Deployable target changes were committed, deployed through the repo's
      deployment path, and smoke-checked, or the deployment blocker is recorded.
