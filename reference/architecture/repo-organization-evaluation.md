# Repo organization: first-principles evaluation

Scope: how `chief-moa` lays out its multiple client surfaces (Android,
browser, macOS, Windows, iOS-seam, website) plus the shared gateway and
release-control plane. This is an evaluation and migration plan only. No
files were moved to produce it.

## 0. What the user's premise gets wrong about the current state

The request assumes "for each surface we have a different repository." That
is not true today. `chief-moa` is already **one repository** containing every
surface:

```
android_app/          browser_extension/      apple_surfaces/
windows_app/           website/                gateway/
release_control_plane/ livekit_worker/
```

All eight live under one root, share one `AGENTS.md` contract, one
`ARCHITECTURE.md`, one CI, one deploy pipeline (`scripts/deploy.sh`), and one
git history. There is exactly one real polyrepo artifact in this picture:
`github.com/natask/agee` — a standalone, open-source, BYOK browser-extension
prototype (`extension/`, `dev.html`, its own `npm run dev/verify/smoke`) that
predates and duplicates `chief-moa/browser_extension`. Its last commit is
2026-06-17, six weeks stale relative to `chief-moa`'s daily commit cadence.
It reads as an abandoned early spike, not a deliberate "browser gets its own
repo" strategy — nothing in `chief-moa`'s docs references it, and its
purpose statement (open-source, bring-your-own-key, no gateway) actively
contradicts the current browser_extension contract (thin client, no
provider keys, gateway-owned). This is worth a plain statement up front:
the instinct that "we already do per-surface repos" is not supported by
what is actually on disk. The one place it accidentally happened is a
liability, not a model to extend.

So the real question is not "should we adopt polyrepo," it's "is monorepo
still correct as this repo now has 8 product surfaces instead of the 4 the
top docs still describe, and does its internal layout follow a recognizable
convention."

## 1. Polyrepo vs. monorepo, argued from first principles

A repository boundary should track the unit that changes atomically, ships
together, and is worked on by one coordinated set of agents. Score each
model against this team's actual constraints, not a generic best-practice
list:

| Constraint (this team, observed) | Polyrepo (repo per surface) | Monorepo (current) |
| --- | --- | --- |
| Solo developer + heavy agent automation reading `AGENTS.md`/`ARCHITECTURE.md` as ground truth | N contracts to keep in sync across N repos; agents lose cross-surface context unless re-fed it | One contract file set, one `ARCHITECTURE.md` boundary doc all surfaces already reference |
| Cross-surface features that must ship together (voice delivery controls, streaming voice, `update_agent_profile` tool contract shared by Android/browser/gateway) | Requires coordinated multi-repo PRs, pinned cross-repo versions, and a release train | One commit changes gateway route + Android client + browser client atomically; `git log` shows the real cross-surface diff |
| One deploy pipeline (`scripts/deploy.sh auto/gateway/android/extension`, `scripts/vps/*`, `Deploy VPS gateway` workflow) | Deploy orchestration has to reach across repos or gateway pins commit SHAs of client repos | Deploy script already reads one tree; no cross-repo pinning needed |
| Agent worktree workflow: **106 active `git worktree` checkouts of this one repo** at the time of this evaluation | Polyrepo would need 106 x N-repo worktree sets, or an umbrella meta-repo re-inventing monorepo | `git worktree add` already gives full-tree isolation per lane at zero extra tooling cost |
| Shared contracts between surfaces (Aggie N/N-1 turn envelope, `moa.reasoning-turn.v2`, browser-delegation envelope, cross-device tool hub) | Contract changes require simultaneous multi-repo release coordination or a published shared-types package | Contract lives in `gateway/lib/*` and is read directly by whichever client PR touches it in the same commit |
| Release authority is explicitly centralized already (`release_control_plane` owns tenant-scoped release graphs across `android`, `browser_extension`, `web`, `gateway`, `macos`, `windows` per `ARCHITECTURE.md`) | Fights the existing design: release plane already treats all surfaces as one coordinated release graph | Matches the existing design directly |

Given these, monorepo is not a defensible-but-debatable choice for this
team — it is close to strictly better on every axis that matters here. The
things polyrepo is usually chosen for (independent versioning per team,
independent CI blast radius, different access control per surface, a
public-facing surface that shouldn't see private surface code) don't apply:
there's one person, one CI budget, and no confidentiality boundary between
surfaces that isn't already a runtime auth boundary, not a source boundary.

### The honest counter-argument (steelmanning the user's instinct)

The user's instinct isn't groundless — it names three real problems that
happen to look like "give each surface its own repo" from outside:

1. **Blast radius.** A gateway-only change currently touches a tree that
   also contains Android/Windows/Swift source, so `git status`,
   `git diff`, and CI scope have to be surface-aware rather than
   repo-aware. Today this is handled by narrow verification commands per
   surface (`AGENTS.md` "Verification Defaults") and by 106 worktrees
   giving each lane its own working tree — but it is handled by
   convention and worktree discipline, not by a repo boundary that would
   enforce it automatically.
2. **Open-source surface area.** `ENGINEERING_STRATEGY.md` states the goal
   is "open-source without becoming hard to navigate." A public browser
   extension repo with its own README/license/issue tracker (which is what
   `natask/agee` actually is) is a legitimate polyrepo pattern for the
   *one* surface meant to be a standalone open-source artifact distinct
   from the product's private/hosted surfaces — Cal.com, Supabase, and
   Ghost all extract exactly one public-facing package this way while
   keeping the rest monorepo. That's not evidence for splitting all five
   client surfaces; it's a narrow, single-surface case that the repo
   already half-attempted and then abandoned mid-migration.
3. **Namespace clarity for a newcomer.** A flat root with 8 product
   directories, 9 root-level markdown files, and non-standard directories
   (`.fabro/`, `.docs/`, `openspec` symlink) does read as cluttered to
   someone who has never seen the project — but that is a *layout*
   problem inside one repo, not a repo-count problem. Splitting repos
   would not fix it; it would just distribute the same clutter into eight
   places instead of fixing it once.

So: disagree with "split into per-surface repos" as the fix, but agree with
the underlying complaint that a first-time reader can't currently tell what
this project is or how its pieces relate at a glance.

## 2. What convention actually applies here

For a single product shipping multiple native/web clients against one
backend, the standard pattern (Turborepo, Nx, and what Cal.com, Supabase,
Expo/EAS, and Sentry's client SDKs monorepo all converge on) is:

```
apps/            # things that get built, packaged, and shipped to an end user or device
  <surface>/
packages/         # shared code consumed by 2+ apps, published or workspace-linked
services/          # long-running backend processes (optional split from apps/ when the
                    #  distinction between "ships to a device" and "runs as a server" matters)
docs/ or reference/ # architecture, specs, strategy — one place, not scattered root files
scripts/            # cross-cutting build/deploy tooling
```

`chief-moa` already has the *content* right — real surface isolation, a
shared architecture doc, narrow per-surface verification commands, a
symmetric per-surface layout (`AGENTS.md` + `CLAUDE.md` + `README.md` +
`docs/` + `scratch/` + `scripts/` repeats identically across `android_app`,
`browser_extension`, and `gateway`). What it lacks against the convention:

- No `apps/` / `services/` grouping — 8 peer directories sit directly at
  root with no visual signal for "this ships to a user device" vs. "this
  runs as our server."
- No workspace tool (no root `package.json`, no `pnpm-workspace.yaml`) even
  though four of the eight surfaces (`gateway`, `browser_extension`,
  `website`, `livekit_worker`) are independent Node packages with their
  own lockfiles — there's no single dependency graph a newcomer or a tool
  like `pnpm -r` can walk.
- Root has 9 markdown files (`README`, `ARCHITECTURE`, `AGENT_WORKFLOW`,
  `AGENTS`, `CLAUDE`, `DEPLOYMENT`, `CONTRIBUTING`, `ENGINEERING_STRATEGY`,
  `HACKATHON_PROJECT_DRAFT`) with overlapping "read this first" lists
  (`AGENTS.md` and `CONTRIBUTING.md` each hand-maintain their own
  first-reads list, already drifting from each other).
- `ENGINEERING_STRATEGY.md` still describes "four owner surfaces"
  (Android, Gateway, Browser extension, Execution machine) — it does not
  mention `apple_surfaces`, `windows_app`, `website`, `release_control_plane`,
  or `livekit_worker`, all of which exist and are committed. This is
  documentation drift, not a naming problem, but it directly undercuts
  "clear to a newcomer": the canonical strategy doc undercounts the
  product surfaces by half.
- `HACKATHON_PROJECT_DRAFT.md` sits at repo root next to `ARCHITECTURE.md`
  with no marker that it's a one-off narrative artifact rather than living
  documentation.
- Naming is inconsistent: `android_app`, `browser_extension`, `windows_app`
  use `snake_case` and an explicit `_app`/`_extension` suffix;
  `apple_surfaces` breaks the "one surface per directory" pattern (it's
  actually a shared Swift library plus one native app, `MoaMac`, plus an
  iOS seam that doesn't have its own directory yet); `website` and
  `gateway` drop the suffix entirely. None of this is wrong per file, but
  there's no single rule a newcomer could infer and apply forward.

## 3. Recommendation

**Keep the monorepo. Do not split per surface.** Fix legibility inside the
one repo you have, in three cheap, low-risk moves, and treat any directory
rename as low-priority given migration cost (Section 5). Separately, resolve
the one real polyrepo artifact (`natask/agee`) by explicitly marking it
superseded rather than leaving it to silently compete with
`browser_extension` for a newcomer's attention.

## 4. Compliance table

| Current path | Recommended path / action | Cost | Priority |
| --- | --- | --- | --- |
| Root: 9 markdown docs with overlapping "read first" lists | Keep `README.md` + `ARCHITECTURE.md` at root (highest-traffic, correctly placed). Move `HACKATHON_PROJECT_DRAFT.md` to `reference/` (it's narrative history, not living contract) | Low — 1 file move + fix inbound links (none found outside root) | High value / low risk |
| `ENGINEERING_STRATEGY.md` "four owner surfaces" table | Update the table to list all 8 committed surfaces (or explicitly scope it as "core loop owners" and link out to `ARCHITECTURE.md`'s System Boundary for the full list) | Low — doc edit only | High value / low risk |
| `AGENTS.md` §Required First Reads vs. `CONTRIBUTING.md` §Start Here (two hand-maintained, drifting lists) | Make one canonical list (`README.md#start-here` already exists and is the most complete); have `AGENTS.md` and `CONTRIBUTING.md` link to it instead of re-listing | Low — doc edit only | Medium |
| `github.com/natask/agee` (separate repo, stale since 2026-06-17, duplicates `browser_extension`'s purpose statement) | Add a one-line "Superseded by chief-moa/browser_extension; kept for historical open-source reference" note to its README, or archive the GitHub repo | Low (doc edit) to Medium (archiving is a one-way signal, reversible by unarchiving) | High value / low risk — this is the one genuine polyrepo-confusion risk found |
| `android_app/`, `browser_extension/`, `windows_app/` (apps) mixed at root with `gateway/`, `release_control_plane/`, `livekit_worker/` (services) and `website/` (also an app) | Group under `apps/{android,browser-extension,macos,windows,web}/` and `services/{gateway,release-control-plane,livekit-worker}/` per Turborepo/Nx convention | **High** — every one of 106 active worktrees has stale paths on rebase/merge; every hardcoded path in `AGENTS.md`, `ARCHITECTURE.md`, `scripts/deploy.sh`, `scripts/vps/*`, CI workflows, and every OpenSpec change under `reference/openspec/changes/` needs updating; Android package/module paths and Gradle settings would need matching updates | Low priority — value is cosmetic/navigational only; cost is the highest in this table for the least behavior change |
| `apple_surfaces` (one directory holding a shared library + `MoaMac` app + an unbuilt iOS seam) | If/when iOS gets its own directory, split into `apps/macos` (or keep `apple_surfaces` as the shared-library home and add `apps/ios` alongside it) rather than growing one directory into two products | No cost now — this is a "when you add iOS" rule, not a rename today | Low priority / defer until iOS exists |
| No root `package.json` / `pnpm-workspace.yaml` tying `gateway`, `browser_extension`, `website`, `livekit_worker` together | Add a root `pnpm-workspace.yaml` listing the four Node packages (no code move required — workspace files can point at existing paths) | Low-Medium — verify each package's scripts still run standalone (`cd gateway && npm run check` etc. must keep working per `AGENTS.md` Verification Defaults) | Medium — real value (single `pnpm install`/`pnpm -r` surface for a newcomer), low risk since no files move |
| `openspec -> reference/openspec` symlink at root | Keep as-is; it's a low-cost compatibility shim for tools/muscle-memory that expect `openspec/` at root | None | No action needed |
| `.fabro/`, `.docs/parallel/` at root (workflow/orchestration scratch state, not product code) | Leave in place; these are agent-tooling directories, not part of the "surface" story a newcomer needs. Optionally note their purpose in `README.md`'s directory list so they don't read as unexplained clutter | Low — one doc sentence | Low |

## 5. Migration cost reality check

This repo currently has **106 active `git worktree` checkouts**. Any
directory rename or move (Section 4's "High" cost row) does not just cost
one PR — it costs a rebase or manual path-fix in every one of those
worktrees, every in-flight OpenSpec change document that names a path
(`reference/openspec/changes/*/proposal.md` and `tasks.md` reference
`android_app`, `gateway`, `browser_extension` throughout), every deploy
script, and every CI workflow. That is why the directory-rename items are
marked low priority despite matching the "textbook" `apps/`/`services/`
convention: the convention gets you organizational legibility, and this
team already has that legibility through symmetric per-surface
`AGENTS.md`/`docs/`/`scratch/`/`scripts/` layout and a single
`ARCHITECTURE.md`. The rename would spend a large, real one-time migration
cost to buy a smaller, mostly-cosmetic improvement on top of what's already
working. The doc-only fixes above (rows 1-3 and 6) buy most of the
legibility improvement a newcomer would notice, at a fraction of the cost.

## 6. Annotated tree map (proposed target state)

This is the recommended near-term target: same directory names and
locations as today (no forced rename), with the doc-hygiene fixes from
Section 4 applied and one new root file (a workspace manifest) added. It is
what "clear to a newcomer" looks like without paying the high-cost rename.

```
chief-moa/
  README.md                    # 30-second orientation + directory map (see below) + start-here links
  ARCHITECTURE.md              # system boundary, ownership, and every runtime flow contract
  ENGINEERING_STRATEGY.md      # updated to name all 8 product surfaces, not 4
  AGENT_WORKFLOW.md            # intent -> spec -> ticket -> implementation -> verification loop
  AGENTS.md                    # agent operating contract; links to README#start-here instead of duplicating it
  CONTRIBUTING.md              # human contributor setup; links to README#start-here instead of duplicating it
  DEPLOYMENT.md                # required reading before any build/release/OTA/deploy task
  CLAUDE.md                    # thin pointer to AGENTS.md
  CHANGELOG.md                 # generated by git-cliff; do not hand-edit
  cliff.toml                   # git-cliff config
  pnpm-workspace.yaml           # NEW: lists gateway, browser_extension, website, livekit_worker as workspace packages
  docker-compose.yml / .preview.yml / .vps.yml   # local/preview/VPS gateway stacks

  android_app/                 # Android overlay + full app: phone UI, permissions, approvals, local execution, receipts
    app/ deploy/ docs/ gradle/ scratch/           (unchanged internal layout)
  browser_extension/           # Chrome extension thin client: capture, page context, brokered page actions
    extension/ docs/ fixtures/ scratch/ scripts/  (unchanged internal layout)
  apple_surfaces/              # Shared Aggie authority Swift library + MoaMac (macOS observation/suggestion surface)
    Sources/ Tests/ scripts/                      (unchanged; iOS gets its own dir here or a sibling apps/ios/ once it exists)
  windows_app/                 # Windows client (Aggie.Windows C# shell + Rust core) — early stage
    Aggie.Windows/ core/ docs/
  website/                     # Public marketing site + Cloudflare Pages Functions (account/customization tools only)
    functions/ public/
  gateway/                     # Self-hosted gateway: auth, model routing, voice, storage, agent-run harness launch
    lib/ migrations/ deploy/ test/ tools/ scratch/
  release_control_plane/       # Cross-surface release authority: channels, promotions, receipts, above all clients
    lib/ migrations/ test/
  livekit_worker/              # Standalone LiveKit (WebRTC) voice transport prototype, flag-gated, not in gateway deps
    src/

  reference/                   # Specs, plans, and research — not runtime code
    openspec/                  # product maps, active changes, and specs (source of truth for in-flight work)
    architecture/              # this file, and future cross-cutting architecture evaluations
    research/                  # investigation notebooks and audits
    intents/                   # standing intent ledger
    scratch/agent-loop/        # working notes for the agent orchestration loop itself
  scripts/                     # cross-cutting build/deploy/release tooling (deploy.sh, vps/, release/, preview/)
  .github/workflows/           # CI: build verification, VPS gateway deploy gate
  .fabro/                      # workflow-orchestration state for the .fabro tool (not product code)
  .docs/parallel/              # Natstack multi-agent lane ledgers (goal.md/merge-ledger.md per parallel run)
```

### A 30-second project description (for `README.md`)

> Chief Moa (agent identity: **Aggie**) is a multi-surface delegated-action
> assistant. One person speaks or types to a phone overlay, a browser
> extension, or (in progress) a desktop app; a single self-hosted gateway
> routes the request to a model, decides what to propose, and every surface
> independently checks and approves any local action before it runs. The
> gateway is the only place that holds provider credentials, conversation
> history, and agent-run state — each client surface is a thin,
> permission-scoped front end that never trusts model output as an
> executable command.

## 7. Staged migration plan

Only Section 4's doc-hygiene rows need action; the directory-rename row is
explicitly **not** recommended to execute now (Section 5). Each stage below
is independently shippable, reversible with a single revert commit, and
does not touch a running surface.

**Stage 1 — doc corrections (no code, no path changes, ships same day)**
1. Update `ENGINEERING_STRATEGY.md`'s owner-surface table to list all 8
   committed surfaces or explicitly scope/link to `ARCHITECTURE.md`.
2. Move `HACKATHON_PROJECT_DRAFT.md` to `reference/HACKATHON_PROJECT_DRAFT.md`
   and fix the one inbound reference if any exists.
3. Replace the duplicated first-reads lists in `AGENTS.md` and
   `CONTRIBUTING.md` with a link to `README.md`'s canonical start-here list.
4. Add the 30-second description (Section 6) to the top of `README.md`,
   plus the annotated directory map.
   Rollback: revert the commit; nothing downstream depends on these files'
   exact wording.

**Stage 2 — external polyrepo cleanup (outside this repo, low risk)**
1. Add a superseded-by note to `natask/agee`'s README, or archive the
   GitHub repo, pointing at `chief-moa/browser_extension`.
   Rollback: unarchive, or revert the README edit — does not touch
   `chief-moa` at all.

**Stage 3 — workspace manifest (additive, no path changes)**
1. Add `pnpm-workspace.yaml` at root listing `gateway`, `browser_extension`,
   `website`, `livekit_worker`.
2. Verify each package's existing standalone scripts still run unchanged
   (`cd gateway && npm run check`, `cd browser_extension && npm run
   verify && npm run smoke`) — the workspace file must not require callers
   to switch to `pnpm -r` for these to keep working, since `AGENTS.md`'s
   Verification Defaults hardcode the `cd <dir> && npm run ...` form.
   Rollback: delete the file; no other config references it yet.

**Stage 4 (deferred, not recommended to schedule) — `apps/`/`services/`
directory grouping.** Only take this on if/when a second person or a
second coordinated agent team starts working the repo such that the
"ships to a device" vs. "runs as our server" distinction needs to be
enforced by directory boundary rather than convention — and even then, do
it as a scripted rename with an automated path-rewrite across all active
worktrees and OpenSpec documents in the same change, not a hand rename.
