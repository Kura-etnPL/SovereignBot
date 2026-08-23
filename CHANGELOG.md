# Changelog

All notable changes to SovereignBot are documented in this file.

## [1.0.0] - Unreleased

SovereignBot 1.0 is the first production release of the supported local-first core. The version remains unreleased until the final security review and RC soak gates pass; merging this changelog does not publish or tag 1.0.0.

### Added

- Local-first multi-agent orchestration with durable tasks, plans, dependencies, progress, independent review, retry, cancellation, and aggregation.
- Codex and Claude Code harnesses with resumable provider session state and governed computer-tool integration.
- Per-agent browser/computer profiles and workspaces behind task-bound authorization, operator takeover, and a dedicated secret-supply channel.
- A local operator console with short-lived operator sessions and passive/redacted worker telemetry.
- Transactional, versioned policy apply/rollback with dry-run validation, immutable policy versions, audit reconciliation, and fail-closed startup recovery.
- `sovereignbot doctor` for passive readiness and integrity diagnostics without model inference or browser startup.
- Offline recovery tooling: integrity-verified core backup, explicit sensitive computer/profile backup, transactional restore, and redacted non-restorable export.
- Explicit crash-recovery inspection/quarantine for recognized atomic-write and governed-bridge leftovers.
- Transactional v0.3 ComputerRegistry → v2 migration with marker-bound crash recovery and pre-commit rollback.
- Deterministic portable release archive, SHA-256 manifest, and Windows PowerShell / POSIX bootstrap installers.

### Security

- Policy remains fail-closed and hard browser/network safety denials cannot be overridden by ordinary allow rules.
- Governed computer/MCP authority is bound to an exact running task and worker identity.
- Operator, worker, provider-session, bridge-capability, and secret-channel authority classes remain separated and redacted from public/operator telemetry surfaces.
- Browser navigation blocks unsafe private/loopback/metadata targets by default.
- Durable audit records are hash chained and credential-shaped fields are redacted before hashing/persistence.
- Installer/recovery paths reject traversal, unsafe roots, symbolic links/junction escapes, special archive entries, tampered payloads, and unsupported state.

### Reliability and recovery

- Startup performs a read-only preflight before initializing or mutating unrelated runtime state.
- Backup capture rechecks file identity/content and state membership before publication; restore validates before swap and rolls back replacement failures.
- Supported ComputerRegistry migration converges idempotently across documented crash windows and never creates replacement credentials before migration commit.
- Release gates exercise Ubuntu and Windows on Node 22/24, real Chrome + ChromeDriver, governed MCP → Chrome, and both portable installers.

### Upgrade notes

Read `docs/v1-migration.md` before upgrading an existing pre-1.0 data directory. Detailed ComputerRegistry migration transaction semantics are documented in `docs/schema-migrations.md`, and state backup/restore guidance is in `docs/state-backup.md`.
