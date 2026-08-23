# Schema migrations

SovereignBot v1.0 does not claim a generic migration engine for arbitrary future state. It guarantees the migration that the supported upgrade path actually needs today: the legacy v0.3 ComputerRegistry layout to the v2 identity-keyed registry layout.

The migration is deliberately narrow, transactional, restartable, and fail-closed. Unknown schema versions, unknown legacy agents, ambiguous legacy directory mappings, altered transaction metadata, unsafe filesystem entries, or a changed configured agent set are not guessed through.

## What changes

Legacy state may contain:

- `computers/state.json` keyed directly by agent id, without a schema version;
- per-agent directories named with the legacy percent-encoding scheme.

The v2 state uses:

- `computers/state.json` with `{ "version": 2, "agents": { ... } }`;
- per-agent directories keyed by the agent id encoded as base64url.

Existing computer tokens, browser profiles, workspaces, and control state are moved with the agent directory. The migration must not silently copy one legacy identity into multiple v2 identities.

## Transaction files

During migration, SovereignBot may create two recovery artifacts directly under `computers/`:

- `migration.json` — the create-once transaction marker;
- `state.json.migration-<migrationId>` — the staged v2 state document.

The marker binds the transaction to:

- a supported migration kind/schema;
- a unique migration id and start timestamp;
- whether the source `state.json` was absent;
- the SHA-256 of the legacy source state;
- the SHA-256 of the deterministic target v2 state;
- the SHA-256 of the sorted configured agent-id set.

These hashes are integrity metadata, not credentials. They prevent restart from treating a different source document or different configured agent set as the same migration.

## Commit order

For a new migration SovereignBot performs the following order:

1. inspect and validate the legacy state and directory mapping;
2. create `migration.json` exclusively (`wx` semantics);
3. create the staged v2 state exclusively;
4. rename each unambiguous legacy agent directory to its v2 identity key;
5. only after every required directory move succeeds, atomically replace `state.json` with the staged v2 state;
6. re-inspect and verify the committed v2 state and directory layout;
7. remove the migration marker;
8. only after migration is complete may normal ComputerRegistry initialization create missing operator/worker tokens or profile/workspace directories.

This ordering matters: state commit is the transaction boundary. Credentials or empty replacement profiles must not be created merely because a migration attempt began.

## Immediate failure and rollback

Before the v2 `state.json` commit, a failure in a newly-created transaction rolls back any directory moves made by that attempt and removes its marker/staged state when cleanup is safe.

If rollback itself fails, SovereignBot does not erase the evidence or pretend the old layout is intact. It surfaces an aggregate failure and leaves the marker/state needed for explicit recovery.

After the v2 state has committed, SovereignBot never rolls the schema backward automatically. A remaining marker means the durable commit happened but cleanup/reconciliation is incomplete; the next startup verifies the target hash and directory layout and finishes cleanup.

## Crash/restart recovery

Startup preflight is read-only. It uses the same migration inspector as ComputerRegistry and allows only migration artifacts that are fully explained by a valid marker. A stage file without a marker, a marker with an invalid hash/schema, a marker for a different configured agent set, or a stage/committed state whose hash does not match the marker fails before normal runtime initialization.

A valid transaction can resume from the supported crash windows, including:

- marker created but stage not yet created;
- stage created before directory moves;
- some agent directories already moved;
- all directories moved while the legacy state document is still active;
- v2 `state.json` committed while `migration.json` still remains.

Repeated restart/recovery is idempotent: already-completed moves are recognized, the deterministic target is revalidated, and completion converges on one v2 state rather than creating duplicate identities or tokens.

## Operator diagnostics

`sovereignbot doctor` does not perform migration. It reports:

- `OK` when no migration is needed or the registry is current;
- `WARN` when the supported migration is needed or a valid transaction is recoverable;
- `ERROR` when migration state is malformed, tampered, ambiguous, or otherwise unsafe.

Doctor output intentionally exposes only sanitized status/count metadata. It does not print migration hashes, marker ids, computer tokens, profile contents, or agent-specific migration details.

## Backup interaction

Recovery backups are not allowed to cross a ComputerRegistry schema transition. Both normal core backup and explicit `--include-computer-state` backup refuse when migration is required, in progress, or awaiting marker cleanup.

Backup checks migration state twice: before capture and again immediately before publishing the bundle. The second check closes the race where a core backup does not otherwise enumerate `computers/**` and a migration begins while other durable files are being copied.

Complete/recover the migration first, run `sovereignbot doctor`, and then create the recovery backup.

## Manual recovery rule

Do not delete `migration.json` or `state.json.migration-*` merely to make startup pass. Those files are transaction evidence. If automatic restart recovery refuses them, preserve the whole `dataDir` and restore a known-good backup or repair the state using the exact failure evidence. Deleting the marker blindly can turn a detectable partial migration into an ambiguous identity/state mismatch.

## Future schema changes

Any future durable schema migration must earn its own explicit version contract and tests. At minimum it must preserve the same release invariants used here: preflight recognition, deterministic target validation, create-once recovery evidence, bounded rollback before commit, idempotent restart after crash, backup interaction, doctor visibility, and frozen-head cross-platform CI evidence.
