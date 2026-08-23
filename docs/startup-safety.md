# Startup safety preflight

SovereignBot v1.0 treats local durable state as a security and recovery boundary. Starting the runtime is not allowed to silently reinterpret or overwrite state that is unsafe, corrupt, or structurally incompatible.

`createRuntime()` therefore begins with a **read-only startup preflight** before normal initialization.

## Ordering guarantee

The preflight runs before normal startup can:

- initialize or append to the audit log
- bootstrap or recover versioned policy state
- prune/persist repeat-safety state
- prune operator-console sessions
- migrate computer registry state
- create worker/operator computer tokens
- create profile/workspace directories
- construct a browser/WebDriver sidecar
- open governed MCP/tool bridges

A hard preflight failure aborts startup at this boundary. Preflight does not perform automatic repair or destructive cleanup.

## What blocks startup

When present, the following state must be readable, structurally valid, and located under normal non-symlink/junction roots:

- `tasks.json`
- `memory.jsonl`
- `task-events.jsonl`
- `audit.jsonl`
- `repeat-state.json`
- `policy-versions/**`
- `computers/**`
- `operator-sessions/**`
- `tool-bridges/`

Hard examples include:

- `dataDir` is a filesystem root or traverses a symlink/junction-like path component
- duplicate task ids or invalid core JSON/JSONL
- ambiguous/non-contiguous persisted task-event sequence
- audit hash-chain tamper
- invalid repeat fingerprints/timestamps
- missing/corrupt active policy state or corrupt immutable policy history
- malformed/unsupported policy transaction marker
- unknown computer state `version`
- empty or symlinked computer token files
- symlink/junction computer/profile/workspace roots
- lossy/ambiguous legacy computer migration state
- malformed operator-session records
- stale governed bridge bootstrap files
- unsupported or stale runtime-owned state paths that require explicit recovery

The failure message begins with `startup preflight failed:` so operators can distinguish this boundary from later runtime errors.

## Recovery that remains supported

Fail-closed startup is not intended to disable recognized recovery paths.

### Policy bootstrap recovery

A known bootstrap transaction marker may proceed only when it matches the current validated config policy and does not conflict with an active pointer.

### Audited policy activation recovery

A committed activation/rollback crash marker may proceed only when:

- the audit chain verifies
- the matching transaction id is durably present in audit
- the active pointer matches the transaction target
- the immutable target policy version exists and its hash matches

The existing `PolicyVersionStore` then performs the recognized marker reconciliation.

### v0.3 computer migration

The existing non-ambiguous v0.3 computer-state migration remains supported. Startup preflight refuses only migration inputs that are ambiguous, malformed, use an unknown explicit version, or would silently drop legacy state for an agent not present in the current config.

## What does not block startup

Startup preflight deliberately does **not** run provider login/inference checks. For example, a configured but currently missing optional Codex or Claude CLI does not make the entire local runtime unstartable.

Use:

```bash
sovereignbot doctor --config .sovereignbot/config.json
```

for broader readiness diagnostics such as optional provider executable/auth availability and browser/WebDriver discovery.

## Stale state and repair

Preflight reports stale runtime scratch or governed bridge bootstrap state but does not delete it. Automatic/destructive cleanup belongs to an explicit recovery/repair path, not ordinary startup. This protects crash evidence and avoids guessing whether a leftover file is safe to discard.

Before manual recovery, create a verified backup when the state is clean enough to back up. See [`state-backup.md`](./state-backup.md).

## Security intent

The preflight is a mutation-order guard, not a replacement for store-level validation. Individual stores continue to validate their own formats and recovery semantics. The goal is to ensure a later subsystem cannot partially initialize unrelated state first and only then discover that a critical durable boundary was already unsafe.
