# Document authority index

This file records the latest read-only documentation authority audit. It is an
inventory, not permission to move, archive, or delete a file. Review useful
facts and incoming links before changing any candidate.

Run the deterministic audit from the repository root:

```sh
node scripts/docs/authority-audit.mjs
```

Use JSON for tooling:

```sh
node scripts/docs/authority-audit.mjs --format json
```

## Current authorities

| Scope | Current authority |
| --- | --- |
| Stable product direction and ordered outcomes | [`CORE_PRODUCT_INTENT.md`](../CORE_PRODUCT_INTENT.md) |
| Live system boundaries and runtime ownership | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Agent implementation workflow | [`AGENT_WORKFLOW.md`](../AGENT_WORKFLOW.md) |
| Build, release, installation, and deployment safety | [`DEPLOYMENT.md`](../DEPLOYMENT.md) |
| Scoped behavior and implementation work | [`reference/openspec/changes`](openspec/changes) |

## Successor metadata convention

Place one of these declarations near the top of a replaced Markdown document:

```md
Successor: [Current document](relative/path.md)
Superseded by: [Current document](relative/path.md)
Replaced by: [Current document](relative/path.md)
```

The audit validates the linked destination. A valid declaration only makes the
old document a review candidate. It does not prove that all useful facts have
moved, and it does not authorize an archive operation.

## Latest audit

The checked-in inventory below is refreshed from the command output when the
documentation set changes. The command remains the detailed authority for
incoming-link locations, duplicate phrase mentions, stale references, OpenSpec state,
and successor declarations.

<!-- authority-audit-summary:start -->

Audit run on the current local `master` documentation tree on 2026-07-29:

| Measure | Count |
| --- | ---: |
| Markdown documents | 463 |
| Resolved incoming Markdown links | 67 |
| Documents with no incoming Markdown link | 428 |
| Duplicate authority phrase-mention groups | 1 |
| Broken local Markdown paths | 1 |
| Decommissioned-host mentions | 42 |
| Active OpenSpec changes | 59 |
| Completed OpenSpec candidates still under `changes/` | 8 |
| Successor declarations | 0 |

The duplicate authority phrase has 30 occurrences across product, architecture,
migration, research, and scoped OpenSpec documents. This is a review queue, not
proof that those documents claim the same scope.

The audit reports one broken absolute link in `__LOG__.md` and 42 mentions of
the configured decommissioned host. Some mentions are historical or explicitly
warn that the machine is decommissioned; review context before changing them.

The completed OpenSpec candidates are:

- `companion-catalog-profile-control`
- `durable-project-state`
- `extension-browser-baseline`
- `extension-settings-voice-control`
- `gateway-runtime-agent-profile`
- `manage-agent-worktree-closure`
- `message-broker-session-router`
- `postgres-work-graph-artifact-store`

No document currently declares recognized successor metadata. The full command
output lists every incoming-link source, stale-reference location, active
OpenSpec change, and archive candidate.

<!-- authority-audit-summary:end -->
