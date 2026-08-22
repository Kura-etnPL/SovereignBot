# State backup, restore, and export

SovereignBot v1.0 provides explicit offline recovery tooling for its local durable state.

The recovery surface deliberately separates three classes of state:

1. **Core durable state** — task state, task events, memory, audit chain, repeat safety, and versioned policy state.
2. **Sensitive computer continuity state** — computer bearer/operator tokens, worker workspaces, and browser profiles that may contain cookies or logged-in sessions.
3. **Ephemeral authority state** — short-lived operator-console sessions and governed tool-bridge bootstrap/capability files.

The default backup includes only the first class. Sensitive computer continuity requires an explicit flag. Ephemeral authority is never backed up or restored.

## Operational rule: stop the runtime first

Backup and restore are **offline-consistent** operations in v1.0. Stop the SovereignBot runtime before running either command.

Backup performs stable reads, hashes every captured file, re-reads/re-hashes every captured source, and re-enumerates the selected state before publishing the bundle. If state changes during capture, it fails instead of claiming a mixed snapshot is consistent. This is a safety check, not an online cross-file transaction protocol.

Restore must also be performed while the runtime is stopped. Running a live process against a `dataDir` while replacing that directory can invalidate any recovery guarantee.

## Core backup

```bash
sovereignbot backup ./backups/sovereign-core --config .sovereignbot/config.json
```

When present, the core bundle contains:

- `tasks.json`
- `task-events.jsonl`
- `memory.jsonl`
- `audit.jsonl`
- `repeat-state.json`
- clean `policy-versions/**` state

It does **not** contain:

- `computers/**`
- `operator-sessions/**`
- `tool-bridges/**`
- a live policy transaction/recovery marker
- known `.tmp-*`, `.new-*`, `.old-*`, staging, or restore scratch
- the application install payload
- the external config file or a hash of the full config

The last rule is deliberate: provider/driver configuration can contain environment credentials, so backup metadata does not derive a fingerprint from the entire config object.

A core recovery backup is still private user data: task input/results, memory, and ordinary audit data are intentionally preserved because this is a recovery copy, not a redacted export.

## Full computer continuity backup

Use this only when preserving browser/workspace continuity is intentional:

```bash
sovereignbot backup ./backups/sovereign-full \
  --include-computer-state \
  --config .sovereignbot/config.json
```

This explicitly adds the complete `computers/**` tree. Depending on the local runtime, that can include:

- durable worker computer bearer tokens
- the durable computer operator token
- worker workspace files
- browser profiles
- browser cookies and logged-in sessions

The manifest marks this bundle as `sensitiveComputerState: true`, and the CLI prints a warning. Treat the output as credential material.

Even full-computer mode never includes `operator-sessions/**` or `tool-bridges/**`; short-lived UI sessions and bridge capabilities are not legitimate recovery state.

A browser profile containing symbolic links/special files is refused rather than copied ambiguously. Stop browser/driver processes and clean transient profile lock artifacts before retrying.

## Bundle format

A backup is a directory:

```text
sovereign-core/
  manifest.json
  files/
    tasks.json
    audit.jsonl
    ...
```

`manifest.json` is versioned and records:

- backup format/version
- creation time
- source SovereignBot version
- backup mode (`core` or `full-computer`)
- whether sensitive computer state is present
- every declared relative file path
- every file size
- every file SHA-256
- original file mode metadata

Only regular files and normal directories are accepted. Absolute paths, traversal, duplicate paths, backslash paths, symlinks, special files, ephemeral authority paths, and undeclared files are rejected.

The bundle is assembled in a sibling staging directory with restrictive permissions and published by rename only after consistency checks pass.

## Restore

Restore into an absent or empty `dataDir`:

```bash
sovereignbot restore ./backups/sovereign-core \
  --config .sovereignbot/config.json
```

A non-empty destination is refused unless replacement is explicit:

```bash
sovereignbot restore ./backups/sovereign-core \
  --replace \
  --config .sovereignbot/config.json
```

Restore verifies the manifest and exact file membership, re-hashes every file, builds a complete staging tree, and validates core state before touching the destination.

Semantic validation includes:

- `tasks.json` shape
- memory/task-event JSONL readability
- repeat-state schema/fingerprints
- audit hash-chain integrity
- policy transaction cleanliness
- active policy pointer/version/hash consistency

For `--replace`, the previous `dataDir` is renamed to a sibling recovery directory. The staged state is installed and validated again before the old recovery copy is deleted. If the staged swap fails, SovereignBot attempts to move the previous directory back. A rollback failure is surfaced explicitly as an aggregate failure rather than guessed around.

Restore never accepts a redacted export as a recovery backup.

## Redacted export

Use export for inspection/support/migration planning when a restorable copy is not desired:

```bash
sovereignbot export ./exports/sovereign-summary \
  --config .sovereignbot/config.json
```

The export is deliberately `restorable: false` and contains aggregate metadata only, including:

- task counts by status/kind
- memory count by scope class
- audit integrity, row count, and event-type counts
- repeat active-fingerprint count
- active policy version/hash
- safe diagnostic codes

It omits:

- task titles/input/results/candidate results/progress data
- memory keys/values
- audit actor/subject/data payloads
- computer tokens/workspaces/browser profiles
- operator sessions
- governed bridge capabilities
- the external runtime config and full-config fingerprints

Export uses a distinct manifest format, so `restore` refuses it even if files are manually rearranged.

## What backup does not prove

The SHA-256 manifest proves self-consistency and detects accidental/tampered file content unless an attacker can rewrite both content and manifest. It is not a cryptographic signature or remote attestation mechanism.

v1.0 does not provide cloud backup, scheduled backup, built-in encryption/key management, or a live multi-file snapshot service. If a full-computer bundle leaves the machine, encrypt and protect it with an external mechanism appropriate for credential-bearing data.
