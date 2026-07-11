# MB merge ledger

| Unit | Branch/worktree | State | Evidence |
|---|---|---|---|
| research + contract | agent/mb-billing-entitlements | complete | packet and hard contract |
| domain + migration | agent/mb-billing-entitlements | green source unit | focused 9/9; gateway 181 pass/1 skip/0 fail; repair audit PASS |

No preview or promotion: this is a gateway schema/domain change and no isolated
Postgres preview, backup/scratch restore, drain, compatibility or rollback
evidence exists. Tier 0 may integrate the committed source unit, but must not
activate payment authority or deploy it as a live migration.
