# Moa portfolio execution workflow

```mermaid
flowchart TD
    U[User vision and confidence targets] --> O[Tier 0: main orchestrator]
    O --> G[Durable goal, ownership map, merge ledger]
    G --> R1[Research: current code and specs]
    G --> R2[Research: platform and deployment inventory]
    G --> A0[Adversarial scope, security, anti-gaming audit]
    R1 --> C[Contract compiler]
    R2 --> C
    A0 --> C
    C --> D{Architecture and ownership complete?}
    D -- no --> O
    D -- yes --> W1[Isolated implementation worktrees]

    subgraph Wave1[Active Wave 1: P1 voice]
      V1[Voice observability lane]
      V2[Voice product-contract lane]
      V3[Browser sampler parity lane]
    end

    W1 --> V1
    W1 --> V2
    W1 --> V3
    V1 --> AR[Auditor ring]
    V2 --> AR
    V3 --> AR

    AR --> AC[Goal correctness]
    AR --> AS[Security and trust boundary]
    AR --> AP[Performance and resources]
    AR --> AQ[Quality, CRAP, complexity]
    AR --> AG[Anti-gaming]
    AC --> Verdict{All claims verified?}
    AS --> Verdict
    AP --> Verdict
    AQ --> Verdict
    AG --> Verdict
    Verdict -- block --> RC[Targeted repair contract]
    RC --> RI[Repair implementer in owning worktree]
    RI --> AR
    Verdict -- pass --> M[Orchestrator serial merge]
    M --> VG[Re-run project gates from staging]
    VG --> P{Preview, rollback, drain, compatibility,
    backup and restore evidence complete?}
    P -- no --> B[Committed artifact plus explicit promotion blocker]
    P -- yes --> PD[Isolated preview and smoke]
    PD --> APY[Guarded active apply]
    APY --> PS[Post-promotion smoke and receipt]
    PS --> N[Start next program]
    B --> N
    N --> P2[P2 bounded browser customization]
    P2 --> P3[P3 durable context retrieval]
    P3 --> P4[P4 development and deployment control plane]
    P4 --> P5[P5 native macOS, iOS, Windows surfaces]
    P5 --> P6[P6 companion catalog and sharing]
```

## Evidence rule

Measured benchmark results and architecture-confidence ratings travel on
separate paths. A mock, loopback, unit test, health response, package creation,
or deploy trigger cannot be substituted for real provider latency, audio heard,
action applied, or deployment confirmed. Every claim enters the claims ledger
and is independently verified, refuted, or left unproven.
