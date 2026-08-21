# Transactional policy activation and rollback

SovereignBot keeps policy reasoning separate from policy authority.

Draft validation and dry-run are pure simulations. Changing the live policy is an explicit operator-only transaction with immutable versions, an atomic active pointer, a transaction marker, and a hash-chained audit commit record.

## Durable layout

Under the runtime `dataDir`:

```text
policy-versions/
  active.json
  transaction.json        # present only while activation/recovery is unresolved
  versions/
    policy_<uuid>.json     # immutable validated version documents
```

Each immutable version contains:

- schema version;
- random version id;
- canonical SHA-256 of the validated policy document;
- creation time;
- source/optional human label;
- parent version id;
- validated policy JSON.

The active pointer contains only the active version id/hash and activation time.

Raw operator session tokens are not stored in policy versions, pointers, or activation audit rows.

## First startup

An existing installation that has no policy-version state bootstraps the configured policy exactly once:

1. validate config policy;
2. write a bootstrap transaction marker;
3. create the immutable initial version;
4. write the active pointer;
5. clear the bootstrap marker.

Later edits to `config.policy` do **not** silently replace the durable active policy. Once version state exists, startup loads the active immutable version.

If version files exist but `active.json` is missing, or a pointer/version hash is corrupt, startup fails closed instead of falling back to the config policy.

## Apply transaction

The operator console uses a short-lived loopback operator session. A worker token, governed MCP capability, or durable computer operator token is not a policy-activation credential.

A normal Apply proceeds as:

1. strict-validate the draft;
2. server-side re-run one or more caller-supplied dry-run expectation checks;
3. reject if a check's expected allow/deny/rule does not match;
4. if the policy hash is already active, return a checked no-op;
5. write a new immutable policy version;
6. construct the new `PolicyEngine` before changing authority state;
7. write an activation transaction marker;
8. atomically move the active pointer to the new version;
9. swap the Governor to the new engine for future decisions;
10. update the in-process runtime policy snapshot;
11. append `policy.activated` to the tamper-evident audit chain;
12. clear the transaction marker.

The audit row includes only safe transaction/version metadata:

- transaction id;
- previous version id;
- target version id;
- target policy hash.

The durable audit record is the activation **commit record**.

## Failure before commit

If active-pointer movement, runtime engine activation, or the audit commit fails before the commit record exists, SovereignBot attempts to restore:

- the previous in-memory `PolicyEngine`;
- the previous runtime policy snapshot;
- the previous durable active pointer;
- the transaction marker is cleared only after a clean rollback.

If rollback itself is incomplete, the transaction marker remains and the manager enters recovery-pending state. Further Apply/Rollback operations in that process are refused.

A restart with an uncommitted activation marker fails closed. It will not guess which policy should win.

## Crash after commit, before marker cleanup

There is a narrow but important crash window after `policy.activated` / `policy.rolled_back` has been appended but before `transaction.json` is removed.

On restart SovereignBot reconciles the marker only when all of the following hold:

- the hash-chained audit contains a matching activation/rollback record;
- that record has the same transaction id and target version;
- the active pointer matches the marker target id/hash;
- the immutable target version verifies against its stored hash.

When those conditions hold, the audit record proves the activation committed and the stale marker can be removed. Otherwise startup fails closed.

If marker cleanup fails during a still-running process after a successful audit commit, the new policy remains active and the manager reports `recoveryPending`. Further policy mutation is locked until restart/recovery so the recovery marker cannot be overwritten.

## Rollback

Rollback does not rewrite history. It selects an existing verified immutable version and runs the same activation transaction with a `policy.rolled_back` audit commit.

The previous and target versions remain in immutable history.

Rollback to the currently active version is a no-op.

## In-flight actions

A policy activation changes **future Governor decisions**.

An action that already passed the Governor and entered its governed side effect is not retroactively re-authorized. This avoids pretending that a policy swap can safely undo an already-authorized side effect.

## Repeat-store safety settings

The policy document includes `repeatWindowMs` and `repeatMaxActiveFingerprints`, but those values configure a persistent safety store whose existing state has already been recorded under the current semantics.

SovereignBot therefore refuses live Apply or live Rollback when the target changes their effective values. Changing those settings requires an explicit restart/migration-level operation rather than an ordinary policy hot swap.

## Operator console

The Policy page exposes:

- active version id and SHA-256;
- in-memory draft editor;
- strict validation;
- dry-run/explain;
- explicit **Apply checked policy** confirmation;
- immutable version history;
- full version inspection;
- explicit rollback confirmation;
- recovery-pending warning.

Editing the draft/action/repeatCount invalidates the last browser dry-run result, disabling Apply until a new dry-run is performed.

The server re-runs the expected dry-run check; browser state is never treated as sufficient proof.

## Security boundary

Versioned policy does not make hard-safety invariants editable. Hard browser/network/secret/task-authority checks still run outside the editable policy and cannot be weakened by activating another policy version.
