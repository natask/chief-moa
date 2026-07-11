# Intent runtime repair contract 5: process-instance stale-lock recovery

## Audit disposition

`BLOCK`. The CAS4 child-process and injected cleanup gates pass, but a stale
complete lock can still survive a real process restart indefinitely when the
replacement process has the same PID.

## Reproduction

Create an aged complete `.append.lock` whose `host` and `pid` equal the current
process but whose durable `process_instance_id` is different. A bounded append
returns `EVENT_SUBSTRATE_LOCK_TIMEOUT`. This models a prior crashed process in
a stable-PID container/supervisor. The lock format already records a unique
process-instance ID, but `jsonAppendLockIsStale` ignores it and treats the PID
as live authority.

## Required repair

1. After the normal stale-age threshold, regard a same-host, same-PID lock with
   a non-empty process-instance ID different from this runtime's ID as stale.
2. Never reap a same-host lock with this runtime's exact PID and exact
   process-instance ID merely because it is old.
3. Preserve conservative handling for remote-host and legacy records where an
   instance mismatch cannot be proven.
4. Add executable coverage for both the prior-instance recovery and current-
   instance non-reaping cases. The recovered append must assign version 1 and
   leave no artifacts.

## Verification

Run the child lock suite, intent suite, event substrate smoke, full gateway
check, and diff check. Do not commit or merge until a fresh reviewer returns
`PASS`.
