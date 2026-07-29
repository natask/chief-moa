# Development and deployment architecture — decision

Date: 2026-07-29. Status: recommended, not implemented.

---

## What to do differently tomorrow

Chrome stops loading the extension from your repo. Load it once from
`~/Library/Application Support/agee/live/extension`, a plain directory that is
not a git worktree and that only `scripts/deploy.sh extension` writes, from a
committed master commit. After that, no agent can change what you click by
switching a branch, because what you click is no longer in git. That is the
whole fix for today's failure. It costs you one Load-unpacked click, once.

Then four habits, each one command:

- `moa work <slug>` — new change, new ephemeral worktree, deps linked not copied.
- `moa pr <n>` — pull a PR into the review lane to play with.
- `moa ship` — the existing `push-master.sh`. Master is still the only deploy path.
- `moa gc` — reclaim disk, delete merged branches.

Keep one root for worktrees: `~/projs/.wt`. Keep four permanent lanes
(android, qa, pr, integrate). Everything else is ephemeral and dies on merge.
Local branches are cache, not records — delete freely, the PR is the record.

Switch gateway installs to pnpm only. That recovers about 10 GiB.

You have 14 GiB free. Run `moa gc` first.

---

## 1. Measured facts

Measured 2026-07-29 on this machine, not estimated.

### Disk pressure is real, and it is the binding constraint

| Metric | Value |
| --- | --- |
| Volume size | 460 GiB |
| **Available** | **14 GiB** |
| All registered worktrees, combined | **28.55 GiB** |

The worktree fleet is twice the free space. "Worktrees take memory" is correct
and currently urgent.

### The fleet

| Metric | Value |
| --- | --- |
| Registered worktrees | 170 |
| Reported `prunable` by git | 0 |
| Worktree paths that no longer exist on disk | 0 |
| Distinct roots | 5 (`~/projs` 151, `~/scratch` 6, `/private/tmp` 13, plus nested) |
| Local branches | 338 |
| Local branches not merged to master | 221 |

Every registered worktree still exists on disk. Nothing is reclaimable by
`git worktree prune` alone — the space is held by live directories, so
reclaiming it is a deletion decision, not a hygiene sweep.

### Where the bytes actually are

Main checkout, 8.16 GiB total:

| Path | Size |
| --- | --- |
| `.context/worktrees` (56 nested worktrees **inside** the main checkout) | 6.0 GiB |
| `.git` | 394 MB |
| `gateway/node_modules` | 218 MB |
| `android_app/app/build` | 46 MB |
| `recovery` | 71 MB |
| `android_app/build` | 8.1 MB |
| `android_app/.gradle` | 3.2 MB |

A pristine worktree with tracked source and nothing built: **19 MB.**

That number reframes the whole problem. Source is not the duplication cost.
A worktree costs 19 MB. A *built* worktree costs 100–600 MB. The tax is
dependencies and build outputs, never the checkout.

### node_modules — the dominant cost, and it is genuinely wasted

| Metric | Value |
| --- | --- |
| `node_modules` directories across the fleet | 72 |
| Combined size | **12.16 GiB** |
| Average | 173 MB |
| Total measured in one `du` pass (hardlinks counted once) | 12,746,912 KB |
| Sum of independent `du` passes (hardlinks recounted) | 12,746,912 KB |

The two totals are **identical to the byte**. That is the proof: there is zero
hardlink sharing between these trees. They are 72 independent full copies.

Cause, confirmed by layout inspection:

| Layout | Count |
| --- | --- |
| pnpm (`node_modules/.pnpm` present, hardlinked to store) | 13 |
| npm flat copies (no `.pnpm`) | **59** |

The main checkout's `gateway/node_modules` has no `.pnpm`, contains npm's
hidden `.package-lock.json`, and 300 sampled files all have link count 1 —
real copies, sharing nothing.

`AGENTS.md` already forbids this ("Never `npm install` here — it rewrites the
pnpm lockfile and creates drift"). The drift has already landed: `gateway/`
tracks **both** `package-lock.json` and `pnpm-lock.yaml`, and `scripts/deploy.sh`
lists `gateway/package-lock.json` in its gateway target patterns while listing
`browser_extension/pnpm-lock.yaml` for the extension. The rule exists and is
being violated because nothing enforces it.

**~10 GiB of the 12.16 GiB is recoverable.** That is the single largest win
available, and it is larger than current free space.

### Gradle — already mostly solved, do not "fix" it

| Path | Size | Shared? |
| --- | --- | --- |
| `~/.gradle` | 3.4 GiB | shared globally |
| `~/.gradle/caches` | 2.3 GiB | shared globally |
| `~/Library/Android/sdk` | 8.1 GiB | shared globally |
| `~/.m2` | 425 MB | shared globally |
| `~/Library/pnpm/store` | 2.1 GiB | shared, but only 13 trees use it |
| Per-worktree `android_app/.gradle` + `build` + `app/build` (124 dirs) | **1.86 GiB** | not shareable |
| Worktrees carrying `android_app/.gradle` | 56 | |

No `GRADLE_USER_HOME` override exists anywhere in `scripts/`, the workflows,
`AGENTS.md`, or `DEPLOYMENT.md`. The Gradle *dependency* cache is therefore
already shared across all 170 worktrees at 2.3 GiB total, not per-tree.

The remaining 1.86 GiB is project-local build output. It is not shareable by
construction — it is derived from that tree's source. The only lever is
deleting it, which means bounding worktree lifetime.

### What Chrome actually loads — today's failure, precisely

`scripts/deploy.sh` targets `browser_extension/extension/`, a path inside a git
worktree. Chrome is pointed at that directory in the main checkout.
`browser_extension/scripts/poke-dev-reload.mjs` says it out loud at line 53:
"it should reload **from this checkout**."

So the loaded extension is defined by whatever is on disk at that path. A
session that switches the main checkout's branch and leaves it dirty silently
redefines the running product. Nothing reports the mismatch, because nothing
records which commit the loaded build came from: `manifest.json` carries a
version (`0.1.128`) but no git sha, and no build stamp exists anywhere in
`extension/` or `configure.mjs`.

That is not a discipline failure. There is no signal to be disciplined about.

External confirmation of the reload semantics that make this sticky: Chrome
reads content scripts and popup assets live off disk, but manifest and service
worker changes require an explicit reload
([dev.to](https://dev.to/solomon/reloading-your-unpacked-chrome-extensions-on-save-from-anywhere-884),
[chrome-extension-auto-reload](https://github.com/robin-drexler/chrome-extension-auto-reload)).
So a stale tree can be partially live — some files current, some not — which is
the worst possible diagnostic state and matches what happened.

---

## 2. The recommended architecture

One architecture. Six invariants. Each is a predicate a script can evaluate and
fail on.

### Invariant 1 — the live artifact is never inside a git worktree

The owner's Chrome loads `~/Library/Application Support/agee/live/extension`.
That directory is populated only by `scripts/deploy.sh extension`, only via
`git archive` from a commit that is an ancestor of `origin/master`, never by
copying a working tree.

`deploy.sh` writes `live/extension/BUILD.json` with the sha, branch, and
timestamp. The extension surfaces that sha in its settings or dev page.

Why this is the load-bearing invariant: git cannot veto a branch switch. There
is no `pre-checkout` hook. Any design that depends on agents not switching the
main checkout's branch is a discipline, and discipline is what failed today. The
only structural fix is to make the running artifact live somewhere git does not
reach. Then a branch switch anywhere becomes harmless to the running product,
and the question "what am I clicking?" has a printed answer.

This is the standard prefix-isolation pattern: rustup dispatches through
`~/.cargo/bin` into `~/.rustup/toolchains/*`, pyenv builds each version into its
own prefix under `~/.pyenv/versions/*`
([pyenv](https://github.com/pyenv/pyenv)). The rationale is identical — an
upgrade in one place must not silently change what something else is running.

**Enforced by:** `moa doctor` asserts (a) the live dir resolves outside every
path in `git worktree list`, (b) `BUILD.json` sha is an ancestor of
`origin/master`, (c) the live dir is not a symlink into a worktree.
`deploy.sh extension` refuses to run if the requested source is a dirty tree.

### Invariant 2 — hot reload is a dev-QA tool, never touching the owner's session

Hot reload stays, scoped: it may target a QA-lane Chrome profile only, launched
with `--user-data-dir` under `~/.wt/qa/`, loading that lane's tree. It may never
write the live dir or poke the owner's default profile.

The current poke script is fire-and-forget into a shared port (7777) and cannot
tell whose extension answered. Under this invariant the QA profile is a distinct
profile, so the blast radius is bounded by construction.

**Enforced by:** the reload poke refuses to run unless `AGEE_DEV_PROFILE` points
at a QA-lane profile dir; `deploy.sh extension` is the only writer of the live dir.

### Invariant 3 — every change starts in a worktree under one root, and its lifetime is bounded

Root: `~/projs/.wt/`. No exceptions — not `/private/tmp`, not `~/scratch`, not
nested inside the main checkout. Five roots is why the fleet became invisible;
one root makes `moa gc` and `moa doctor` total rather than best-effort.

Two classes:

**Ephemeral** — `~/projs/.wt/x/<slug>`, one per change, created by `moa work`,
deleted on merge or after 7 idle days. Cap 8 concurrent, matching the existing
global cap.

**Pool** — four permanent lanes, because each holds a cache expensive to rebuild:

| Lane | Why permanent |
| --- | --- |
| `~/projs/.wt/android` | Gradle project cache + build outputs; also serializes Android builds (see Invariant 4) |
| `~/projs/.wt/qa` | Chrome QA profile, fuzz corpora, device state |
| `~/projs/.wt/pr` | `gh pr checkout` target, reused across PRs |
| `~/projs/.wt/integrate` | merge/conflict resolution and the final repo-wide gate |

This is the owner's own instinct, adopted: "A worktree for fuzzing makes sense…
task-oriented ones." It is correct, and the measurement says why. A worktree's
source is 19 MB — free. Its *cache* is 100–600 MB — expensive. So pool exactly
the lanes whose caches you want to keep warm, and make everything else
ephemeral, because an ephemeral worktree that never builds costs 19 MB and an
ephemeral one that does build returns its build output on deletion.

Decision on the three options posed: **hybrid, ephemeral-dominant with a
four-lane pool.** Rejecting mostly-master-with-few-worktrees because many agents
run concurrently and a shared tree is precisely today's failure. Rejecting
pure-ephemeral because Android's Gradle project cache and the QA Chrome profile
would be rebuilt constantly for no reason.

**Enforced by:** `moa work` is the only creation path and refuses roots outside
`~/projs/.wt`; `moa doctor` fails if a registered worktree sits outside the root
or if ephemeral count exceeds 8.

### Invariant 4 — dependencies are shared by default; copying is a bug

Three concrete mechanics, in order of payoff:

**(a) pnpm only, with the global virtual store.** Delete
`gateway/package-lock.json`, remove it from `deploy.sh` target patterns, and set
`enableGlobalVirtualStore=true`. pnpm documents this feature for exactly this
situation: it is "most useful when you have multiple checkouts of the same
project on disk — for example, when using git worktrees for multi-agent
development" ([pnpm global virtual store](https://pnpm.io/global-virtual-store)).
It places one shared virtual store at `<store>/links/` keyed by dependency-graph
hash, so each worktree's `node_modules` becomes symlinks into already-realized
shared content instead of paying full materialization again.

Caveats, stated because they bite: the store must be on the same filesystem as
the projects or pnpm silently falls back to copying
([pnpm](https://pnpm.io/symlinked-node-modules-structure)) — it is, both under
`~`. And two trees with divergent lockfiles are safe, because pnpm hardlinks per
*resolved version*, not per package name.

Expected recovery: ~10 GiB of the 12.16 GiB.

**(b) Do not give Gradle per-worktree homes.** `~/.gradle` is already shared and
that is the right answer; isolating it per worktree would multiply 2.3 GiB by
the fleet. The known cost of sharing is lock contention between concurrent
builds — build-cache and file-hash-cache lock timeouts are documented real
failures ([gradle#2737](https://github.com/gradle/gradle/issues/2737),
[Gradle forum](https://discuss.gradle.org/t/avoiding-gradle-locking-issues-with-concurrent-gradle-task-runs/30259)).
The mitigation chosen here is not isolation but **serialization**: Android builds
run in the `android` lane, one at a time, behind a lock file. That converts a
flaky-contention problem into a queue, which is what the owner already asked for
("push it to be done in a certain worktree").

**(c) Reject shared/symlinked `node_modules`.** A single `node_modules` symlinked
across worktrees breaks the moment two branches' lockfiles diverge, and it will
fail confusingly rather than loudly. pnpm's store gets the same saving with
per-tree correctness preserved.

**Enforced by:** `moa doctor` fails if any `package-lock.json` exists in the
repo, or if any `node_modules` lacks `.pnpm`.

### Invariant 5 — a local branch must have a worktree, an open PR, or be deleted

Local branches are cache, not state. The record is the remote plus the PR.
`gh pr checkout` fetches on demand, so a local branch is never required to
review anything.

The owner's lean — "always clutter" — is upheld, with the measurement behind it:
338 local branches, 221 unmerged. That is not a working set; it is sediment.

Tested against his two legitimate cases:

- **PR review**: does *not* justify keeping local branches. `gh pr checkout`
  creates the branch on demand and `moa drop` removes it. His liked workflow
  survives Invariant 5 intact.
- **Long-lived release branch**: does not apply to this repo. Master *is* the
  release trigger. Rollback is by previous artifact and ref — `vps-deploy`
  history, the versioned OTA store, the previous extension package — not by a
  parallel branch. A release branch here would add a second deploy path with no
  rollback benefit.

So: no long-lived branches, and no git-flow. This is textbook trunk-based
development, and the published thresholds line up — branch lifetime under a day,
"three or fewer active branches"
([DORA](https://dora.dev/capabilities/trunk-based-development/)), branch owned by
one developer, closed out on merge
([trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/short-lived-feature-branches/)).
DORA's 2019 report found elite performers 2.3x more likely to practise it.

**Where that literature does not transfer:** all of it is written for teams. The
DORA guidance spends its length on coaching resistant developers and building
advocate groups — irrelevant here, decided by fiat. Code review as a merge gate
also does not transfer: there is no second human, so the gate is CI in
`push-master.sh`, not approval. And the "one developer per branch" rule, written
to stop humans colliding, maps cleanly onto one *agent* per branch, which is
convenient rather than constraining. Take the numeric thresholds; discard the
change-management framing.

### Invariant 6 — master is the only deploy path, and it is already correct

No change. `scripts/release/push-master.sh` already pushes the branch, opens a
PR, waits for the same CI that master runs, fast-forwards only on green, and
then verifies the exact live commit via `wait-for-live-commit.sh`. It mirrors the
extension version gate locally to fail fast. This is the strongest piece of
existing machinery in the repo and the architecture is built around it, not over
it.

Invariant 1 completes it: today master can be green and promoted while the owner
clicks something else. With the live dir fed only from an `origin/master`
ancestor, "verified" and "running" become the same object.

---

## 3. Ceremony budget

Nothing here is allowed to cost more than one command. Costs are per use.

| Action | Command | Keystrokes | Time | Frequency |
| --- | --- | --- | --- | --- |
| Start a change | `moa work <slug>` | ~15 | ~15 s (deps linked, not installed) | per change |
| Review a PR | `moa pr 123` | ~10 | ~10 s | per PR |
| Ship | `moa ship` | 8 | unchanged (CI wait) | per release |
| Discard a change | `moa drop <slug>` | ~15 | ~2 s | per change |
| Reclaim disk | `moa gc` | 6 | ~30 s | weekly, or cron |
| Check invariants | `moa doctor` | 10 | ~3 s | **never manually** |
| Repoint Chrome | one Load-unpacked click | — | ~30 s | **once, ever** |

`moa doctor` has a deliberate cost of zero keystrokes because a check the owner
has to remember is exactly the ceremony he refuses. It runs from `deploy.sh`,
from `push-master.sh`, and at agent session start. If it never appears in his
typing, it is not ceremony; it is a guardrail.

Anything not on this table is cut. Specifically cut: per-change OpenSpec
documents for routine work, preview deployments for the extension (the live-dir
swap *is* the preview boundary), and manual worktree bookkeeping.

---

## 4. What this structurally prevents, mapped to real failures

| Failure that actually happened | Which invariant kills it | How |
| --- | --- | --- |
| Extension loaded from main checkout; another session switched the branch and left it dirty; verified work sat on master while the owner clicked different code, undetectably | 1 | The live dir is not in git. A branch switch cannot reach it. `BUILD.json` prints the sha, so a mismatch is visible instead of silent |
| Partially-stale extension (content scripts current, service worker not) | 1 | The live dir is replaced atomically from one commit; no mixed state exists |
| 12.16 GiB of npm copies despite an existing rule against `npm install` | 4 | `moa doctor` fails on any `package-lock.json` or non-pnpm `node_modules` — the rule becomes a predicate instead of a sentence in a doc |
| Two tracked lockfiles in `gateway/` (drift the docs forbid) | 4 | Same check; `package-lock.json` deleted and removed from deploy patterns |
| 170 worktrees across 5 roots, invisible, 2x free disk | 3, 5 | One root plus bounded lifetime makes `moa gc` total rather than partial |
| 221 unmerged local branches | 5 | Branch without worktree or open PR is deleted |
| Concurrent Gradle builds contending on one `~/.gradle` | 4b | Android builds serialized in one lane behind a lock |
| A dev reload reaching the owner's browser | 2 | Reload requires a QA-lane profile; live dir has one writer |

---

## 5. Migration path

Ordered. Disk first, because there is only 14 GiB free and step 6 needs
headroom.

| # | Step | Who |
| --- | --- | --- |
| 1 | Finish the in-flight merged-branch sweep (already running) | automatable, in progress |
| 2 | Delete build outputs (`build/`, `app/build/`, `.gradle/`) in every worktree idle > 7 days. Recovers up to 1.86 GiB, rebuildable | automatable |
| 3 | Delete `node_modules` in every worktree idle > 7 days. Recovers most of 12.16 GiB immediately, before any pnpm work | automatable |
| 4 | Consolidate roots: move surviving worktrees under `~/projs/.wt`, retire `/private/tmp`, `~/scratch`, and `.context/worktrees` as worktree roots | automatable |
| 5 | Delete local branches with no worktree and no open PR | automatable |
| 6 | Delete `gateway/package-lock.json`; remove it from `deploy.sh` target patterns; set `enableGlobalVirtualStore=true`; reinstall the pool lanes with `pnpm install --frozen-lockfile` | automatable, needs one verification run |
| 7 | Teach `deploy.sh extension` to materialize `~/Library/Application Support/agee/live/extension` from an `origin/master` ancestor via `git archive`, and write `BUILD.json` | automatable |
| 8 | Surface the `BUILD.json` sha in the extension UI | automatable |
| 9 | **Repoint Chrome at the live dir** (`chrome://extensions` → Load unpacked → remove the old entry) | **one-time user action, ~30 s** |
| 10 | Gate the dev-reload poke behind a QA-lane profile | automatable |
| 11 | Write `moa` (`work`, `pr`, `ship`, `drop`, `gc`, `doctor`) | automatable |
| 12 | Wire `moa doctor` into `deploy.sh`, `push-master.sh`, and agent session start | automatable |
| 13 | Update `AGENTS.md`: one worktree root, pnpm only, live dir is not the repo | automatable |

Exactly one step requires the owner: step 9, one click, once.

Steps 2–5 are safe in any order and reversible (everything deleted is either
rebuildable or on the remote). Step 6 is the only one that can break a build,
so it lands with a verification run. Steps 7–9 are the ones that fix today's
bug; they can be done before 2–6 if the bug matters more than the disk, but the
disk is at 14 GiB, so disk goes first.

---

## 6. Deliberately rejected

**Bare repo + worktrees-only layout** (`.bare/` plus sibling worktrees, the
commonly recommended pattern —
[infrequently.org](https://infrequently.org/2021/07/worktrees-step-by-step/),
[nakatechlabs](https://nakatechlabs.com/blog/2025/git-worktree/)). It is the
textbook answer to "protect the primary checkout," and I am declining it.
Reason: 170 registered worktrees and multiple agent harnesses assume
`~/projs/chief-moa` is an ordinary checkout — Claude Code's own
`.claude/worktrees` lives inside it. Migration risk is high, and Invariant 1
already removes the bug the layout would fix, at one click instead of a fleet
rewrite. Reconsider only if the main checkout keeps getting corrupted for
reasons other than the extension path.

**Per-worktree `GRADLE_USER_HOME`.** Would isolate lock contention at the cost
of multiplying 2.3 GiB of shared cache. Wrong trade at 14 GiB free.

**Symlinked or shared `node_modules` across worktrees.** Breaks silently when
lockfiles diverge. pnpm's store achieves the saving safely.

**A container or devcontainer per agent.** The Android SDK is 8.1 GiB, and ADB
device access plus a real Chrome profile do not containerize cheaply on macOS.
The gateway already has a Docker preview path; extending containers to the
client surfaces buys isolation this design gets from directories.

**Long-lived release branch / git-flow.** Master is the deploy trigger; rollback
is by artifact and ref. A release branch adds a second path and no safety.

**Hot reload into the owner's session.** Excluded by requirement, and correctly:
Chrome's partial-live-reload semantics make a half-updated extension a genuine
diagnostic trap.

**Per-change preview deployment for the extension.** The live-dir swap already
separates running from developing. A second preview layer would be ceremony
costing more than it saves.

---

## 7. Honest weaknesses of this recommendation

1. **It fixes one surface structurally and the others only by convention.**
   Invariant 1 makes the *extension* immune to branch switches. The local
   gateway dev server, and any script resolving `ROOT_DIR` from the main
   checkout, still read whatever is on disk there. I am removing the blast
   radius for the surface that burned him, not for all surfaces. A second
   incident on a different surface is possible and this design would not have
   prevented it.

2. **Git cannot veto a branch switch, and I did not solve that.** I routed
   around it. If a future failure depends on the main checkout's branch being
   trustworthy, the bare-repo layout I rejected becomes the right answer after
   all.

3. **pnpm's global virtual store is a recent feature.** If it misbehaves, the
   fallback is ordinary per-worktree pnpm installs — still far better than 59
   npm copies, but not the near-zero marginal cost claimed. The ~10 GiB figure
   is the optimistic end.

4. **Serializing Android builds makes Android the throughput bottleneck.** When
   several agents touch Android at once they queue. I chose predictable slowness
   over intermittent lock-timeout failures, but it is a real cost and it will be
   felt on Android-heavy days.

5. **`moa doctor` is only as good as its call sites.** I claimed zero ceremony by
   wiring it into other commands. If those call sites are incomplete, the
   invariants degrade to documentation — which is exactly how the existing
   "never `npm install`" rule failed. The check must fail builds, not print
   warnings.

6. **The 7-day idle threshold in `moa gc` is a guess.** It is not derived from
   measured access patterns. If agent sessions routinely resume older
   worktrees, it will delete warm caches and the pool will need to grow.

7. **Ephemeral worktrees lose uncommitted work by design.** With `moa drop` and
   a 7-day sweep, an agent that leaves work uncommitted loses it. The repo
   already requires committing every completed unit, so this is intended
   pressure — but it will eat something eventually.
