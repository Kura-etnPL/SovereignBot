# Changelog

All notable changes to SovereignBot are documented in this file.

## [1.1.1] - 2026-08-25

SovereignBot 1.1.1 is the corrective Desktop release: v1.1.1 corrects the Desktop provider wiring and release provenance gaps in v1.1.0. The published `desktop-v1.1.0` tag and assets remain immutable as history; this version makes the product claims true — real Codex/Claude execution in normal mode, trusted workspace-bound provider processes, independent model review, model synthesis, and a read-only-verify → downstream-publish release chain.

### Fixed

- Desktop normal mode no longer contains Echo agents: the runtime roster is built from passive provider discovery plus validated settings (per-provider enable flags, role assignment constrained to main-generated identities), and Demo Mode is the only explicit Echo path.
- Goal pipeline runs a real planner agent; untrusted proposals are strictly validated (unknown capabilities, duplicate keys, missing instructions, forward dependencies, oversize, and any authority-bearing field reject the whole proposal) with bounded planner-driven repair instead of a silent single-step fallback.
- Worker steps carry concrete instructions and public dependency results; reviewRequired steps get an independent reviewer identity whose strict `{decision, notes}` output drives Core review, with bounded changes_requested retry that resumes the same provider session.
- Final synthesis is produced by a real synthesizer task over public results only; partial failures remain visible.
- Selected workspaces are now bound to execution: an internal-only `delegateTrusted` channel stamps a validated execution context, Codex/Claude child processes run with the trusted canonical cwd (`--cd` for Codex), public projections strip it, and public submit/delegate paths can never smuggle one.
- A verified provisioned ChromeDriver reaches the production runtime computer configuration; only the worker identity gains governed browser tooling.
- Central graceful shutdown cancels active goals within bounds, closes governed bridges and the managed driver factory, and leaves no orphan provider children.
- Desktop publication now requires current-main + merged-PR provenance through a read-only verify job; the downstream publish job holds write authority but never rebuilds, refuses moved tags and release overwrites.

### Added

- Fake-provider contract shims drive the packaged/installed end-to-end gate: planner → workers → independent review (one changes_requested cycle) → synthesis must complete inside the installed app with transcript canaries proving phase coverage, trusted-cwd equality, session-resume continuity, zero Echo participation, and no raw session id in public surfaces.
- Provider sign-in helper launches fixed, help-derived CLI login commands in a visible console; renderer may pass only the provider name.
- Version freeze across root package, core version module, CLI banner, /health, desktop package, About/handshake, changelog, and release notes at stable `1.1.1`.

### Added (Desktop foundation, shipped experimentally in 1.1.0)

- `desktop/` Electron package with hardened BrowserWindow defaults, enumerated IPC, secure custom protocol, and packaged smoke coverage.
- Internal Node runtime injection (`SOVEREIGNBOT_INTERNAL_NODE`) so governed MCP bridge, WebDriver sidecar, and npm-shim provider launches keep working when `process.execPath` is no longer a Node interpreter.

## [1.0.0] - 2026-08-24

SovereignBot 1.0 is the first production release of the supported local-first core. The security review and dedicated Windows/Linux RC soak gates passed before this stable version freeze; publication remains bound to the reviewed main-branch CI and release workflow rather than to this changelog entry alone.

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
- Deterministic RC soak coverage with repeated same-dataDir restart/retry/review/cancel/policy/repeat-guard cycles and three serialized full-suite rounds on both Ubuntu and Windows.

### Security

- Policy remains fail-closed and hard browser/network safety denials cannot be overridden by ordinary allow rules.
- Governed computer/MCP authority is bound to an exact running task and worker identity.
- Operator, worker, provider-session, bridge-capability, and secret-channel authority classes remain separated and redacted from ordinary public/operator surfaces while required provider continuity remains internal recovery state.
- Ordinary Operator, CLI, and loopback task APIs project provider continuity safely and do not expose raw harness environment/configuration authority.
- Browser navigation blocks unsafe private/loopback/metadata targets by default.
- Durable audit records are hash chained and credential-shaped fields are redacted before hashing/persistence.
- Installer/recovery paths reject traversal, unsafe roots, symbolic links/junction escapes, special archive entries, tampered payloads, and unsupported state.

### Reliability and recovery

- Startup performs a read-only preflight before initializing or mutating unrelated runtime state.
- Backup capture rechecks file identity/content and state membership before publication; restore validates before swap and rolls back replacement failures.
- Supported ComputerRegistry migration converges idempotently across documented crash windows and never creates replacement credentials before migration commit.
- Release gates exercise Ubuntu and Windows on Node 22/24, real Chrome + ChromeDriver, governed MCP → Chrome, and both portable installers.
- The exact pre-version RC product tree passed the ordinary seven-job release matrix plus dedicated three-round Ubuntu/Windows soak jobs with no unresolved P0/P1 defect.

### Upgrade notes

Read `docs/v1-migration.md` before upgrading an existing pre-1.0 data directory. Detailed ComputerRegistry migration transaction semantics are documented in `docs/schema-migrations.md`, and state backup/restore guidance is in `docs/state-backup.md`.
