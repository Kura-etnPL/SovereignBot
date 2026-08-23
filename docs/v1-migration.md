# Upgrading to SovereignBot 1.0

These notes cover the supported upgrade path from pre-1.0 local SovereignBot state to the v1.0 core. They are operational guidance, not a generic promise that arbitrary unknown future schemas can be migrated automatically.

## Before upgrading

1. Stop the SovereignBot runtime. v1 recovery backups are intentionally offline-consistent rather than claiming a live cross-file snapshot.
2. Preserve the external config file separately. Recovery backups do not silently copy the config because harness/driver environment fields may contain credentials.
3. On a version that already provides the v1 recovery tooling, run `sovereignbot doctor --config <path>` and resolve hard integrity errors before creating a new backup.
4. Create a core recovery backup with `sovereignbot backup <output> --config <path>`. If browser login/profile continuity is required, use `--include-computer-state` only intentionally and protect that backup as credential-sensitive material. Full backup/restore/export behavior and the sensitive-state boundary are documented in `state-backup.md`.
5. Do not manually delete policy transaction markers, ComputerRegistry migration markers, staging files, or crash-recovery evidence merely to make startup pass.

## ComputerRegistry v0.3 → v2

The supported schema migration converts legacy ComputerRegistry state/directories into the v2 identity-keyed layout. It preserves existing per-agent tokens, profile/workspace directories, and any durable control state present in legacy `computers/state.json`.

If the legacy registry has directories/tokens but no `state.json`, there is no durable control mode to recover; v2 control correctly falls back to the registry default while the existing token/profile/workspace continuity is retained.

Migration is transaction-bound and crash recoverable. The runtime may temporarily create `computers/migration.json` and a `state.json.migration-*` staged target. Startup recognizes only marker-bound states whose source/target/agent-set integrity metadata matches. Supported restart windows converge idempotently; malformed/tampered/orphan migration state fails closed.

Do not delete those files manually. The full transaction ordering, rollback boundary, crash windows, and recovery rules are documented in `schema-migrations.md`.

## Backups during migration

Core and full-computer backups deliberately refuse to run while the ComputerRegistry migration is required, active, or awaiting cleanup. Backup checks migration status both before capture and immediately before bundle publication so a migration cannot begin unnoticed in the middle of a core backup.

Complete/recover the migration first, run `sovereignbot doctor`, then create the recovery backup. See `state-backup.md` for the recovery-bundle format, restore replacement semantics, and the distinction between core and credential-sensitive computer/profile backups.

## Policy state

Policy state is already versioned independently. Startup validates immutable policy versions, the active pointer, transaction markers, and the audit chain before normal runtime initialization. Unresolved or inconsistent policy transactions are fail-closed and must be reconciled by the supported recovery path rather than by falling back silently to the config policy.

## Computer/browser credentials

Default core backups exclude `computers/**`, operator sessions, governed bridge capabilities, and browser profiles. `--include-computer-state` is an explicit sensitive recovery mode that may include worker/operator bearer tokens, browser cookies/login state, and workspace content.

Never publish or attach a full-computer backup to a GitHub issue/release. Public release artifacts contain application code/docs/installers, not runtime data or local credentials.

## After upgrading

1. Start SovereignBot with the same intended configured agent identities needed to complete any supported ComputerRegistry migration.
2. Run `sovereignbot doctor --config <path>` after startup/recovery.
3. Verify the audit and active policy state are healthy.
4. If governed computer workers are used, verify the expected browser/profile/workspace continuity before discarding the pre-upgrade backup.
5. Keep the last known-good backup until the upgraded runtime has completed ordinary restart/retry/review activity successfully.

## Rollback expectations

The portable installer has its own transactional upgrade rollback for application files. Durable runtime schema migration is different: before the v2 ComputerRegistry state commit, migration attempts roll safe directory moves back; after the v2 state commit, a leftover migration marker is recovered forward. SovereignBot does not automatically pretend an already-committed v2 state is legacy again.

If rollback/recovery cannot be completed safely, preserve the entire data directory and restore a known-good recovery backup rather than editing transaction evidence by hand.
