# Crash recovery quarantine

SovereignBot v1.0 does not delete suspicious runtime state during ordinary startup. `createRuntime()` fails closed on known stale crash artifacts, and `sovereignbot doctor` reports them without cleanup.

The explicit `recover` command provides a deliberately narrow offline recovery path for artifacts whose ownership and filename/location format are proven by the current runtime implementation.

## Inspect first

```bash
sovereignbot recover --config .sovereignbot/config.json
```

Inspection is read-only. It reports:

- recognized `recoverable` artifacts by relative path, category, and size
- `blockingUnrecoverable` entries that look unsafe, unknown, or outside the audited cleanup patterns
- accepted/running `activeWork` that prevents apply
- whether a policy transaction marker is present, without printing transaction ids or policy contents
- `canAttemptApply`

The report never prints stale file contents. In particular, governed bridge capability values are not emitted.

## Apply offline

Stop SovereignBot and all provider/browser/WebDriver/governed-tool subprocesses, then run:

```bash
sovereignbot recover --apply --config .sovereignbot/config.json
```

An explicit quarantine path can be supplied:

```bash
sovereignbot recover --apply \
  --quarantine ../sovereign-recovery-2026-08-23 \
  --config .sovereignbot/config.json
```

The quarantine must be outside `dataDir`, under a normal writable non-symlink/junction path, and on the same filesystem as `dataDir` so recovery can use atomic rename semantics.

`--apply` is not a live-runtime coordination protocol. Durable `accepted`/`running` tasks block apply, but there is no claim that this alone can prove another arbitrary process is absent. The operational requirement to stop the runtime/workers remains mandatory.

## Exact recoverable patterns

Recovery does **not** recursively delete `*.tmp-*`.

The current audited atomic-write leftovers are only:

- `tasks.json.tmp-<pid>-<uuid>` directly under `dataDir`
- `repeat-state.json.tmp-<pid>-<uuid>` directly under `dataDir`
- `policy-versions/active.json.tmp-<pid>-<uuid>`
- `computers/state.json.tmp-<pid>-<uuid>`

Governed bridge crash leftovers are only the exact filenames produced by the bridge manager:

- `tool-bridges/bridge_<uuid>.bootstrap.json`
- `tool-bridges/bridge_<uuid>.claude-mcp.json`

Anything merely resembling temporary state but not matching these exact audited location/name shapes is a blocker, not an automatic cleanup target.

This is especially important for `computers/<agent>/workspace/**` and browser profiles: a legitimate user/browser file can contain `.tmp-`, `.old-`, or similar text in its filename and is never selected just because of that substring.

## Transaction model

Apply follows this sequence:

1. Build a deterministic recovery plan and SHA-256/size snapshot every planned regular file.
2. Refuse unsafe roots, unknown bridge entries, unrecognized controlled-root scratch, or accepted/running durable work.
3. Create a restrictive sibling quarantine staging directory outside `dataDir`.
4. Re-verify each source and move it by same-filesystem rename into a mirrored relative path.
5. Re-hash the moved file to confirm the quarantined bytes match the plan.
6. Write a versioned quarantine manifest containing metadata/hashes only, not file contents.
7. Run the read-only startup preflight against the cleaned `dataDir`.
8. If preflight succeeds, atomically publish the quarantine directory.
9. If any move, post-move hash, manifest, preflight, or publish step fails, move every already-quarantined artifact back to its original path in reverse order.
10. If cleanup and rollback both fail, surface an aggregate error instead of guessing which state is authoritative.

The published quarantine is never automatically deleted by later startup. It is recovery evidence and may contain sensitive task or bridge bootstrap material; protect it accordingly.

## Policy transaction markers are never cleanup targets

`policy-versions/transaction.json` is durable recovery state, not a temporary file. `recover` reports only its presence/basic kind metadata and never moves or deletes it.

After stale artifacts are temporarily moved, startup preflight still evaluates the policy transaction:

- a recognized bootstrap marker matching current config may proceed through existing policy bootstrap recovery
- an audited committed activation/rollback marker may proceed through existing `PolicyVersionStore` reconciliation
- an uncommitted or otherwise ambiguous activation remains fail-closed

If such a policy marker makes post-quarantine preflight fail, `recover --apply` restores all moved stale artifacts and returns the error. It does not erase the policy evidence to make startup pass.

## Why doctor and recover intentionally differ

`doctor` is a passive diagnostic and can flag broad temp/recovery-looking artifacts for inspection. `recover --apply` is mutating and therefore uses a much narrower allowlist tied to exact current writers.

A future runtime that introduces a new atomic scratch path must explicitly add and test that writer's location/pattern before recovery may quarantine it. Unknown future durable state is never silently discarded.

## What recover does not repair

`recover` does not rewrite:

- corrupt `tasks.json`
- corrupt memory/task-event JSONL
- a tampered audit chain
- invalid repeat state
- arbitrary policy corruption
- an ambiguous uncommitted policy activation
- browser/workspace content

Use a verified backup/restore path for state replacement when appropriate. See [`state-backup.md`](./state-backup.md). Startup-state behavior is documented in [`startup-safety.md`](./startup-safety.md).
