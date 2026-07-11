# M4 deployment control plane manager goal

Implement the smallest coherent source unit that materially advances the typed
deployment state machine inside the existing gateway work-history control plane:
proposal -> preview -> verify -> claim -> guarded apply -> immutable receipt ->
rollback.

Branch: `agent/m4-deployment-control-plane`

Worktree: `/Users/natnaelkahssay/projs/chief-moa-worktrees/m4-deployment-control-plane`

Current slice owns `gateway/lib/work-history.js`, focused deployment-control
tests/smokes, this manager packet, and only minimal architecture/spec text if
the state machine contract changes. It uses deterministic fake adapters only.
It does not touch live deployment scripts, raw shell authority, provider/model
credentials, or active promotion.
