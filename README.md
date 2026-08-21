<div align="center">

# SovereignBot

**Local-first AI coworkers with durable memory, supervisor/worker orchestration, governed computer actions, and no mandatory cloud control plane.**

[Architecture](docs/architecture.md) · [Task graph](docs/task-graph.md) · [Codex](docs/codex.md) · [Claude Code](docs/claude-code.md) · [Computer](docs/computer.md) · [Governed MCP](docs/governed-mcp.md) · [Operator console](docs/operator-console.md) · [Policy activation](docs/policy-activation.md) · [Installation](docs/installation.md) · [Roadmap](docs/roadmap.md) · [Security](SECURITY.md)

</div>

SovereignBot separates **intelligence from authority**. Workers can be local processes or independently authenticated subscription CLIs such as Codex and Claude Code, while SovereignBot owns durable task state, routing, policy, review, memory, computer authority, and audit.

Core principles:

- **local durable state** — no required hosted memory/thread backend;
- **no mandatory metered model API** — the runtime boots without provider credentials;
- **resumable Codex + Claude Code workers** using independently authenticated local CLIs;
- **supervisor → worker DAGs** with explicit ownership, progress, retry, cancellation, and independent review;
- **governed browser/computer actions** with task-bound authority and fail-closed policy;
- **structured W3C WebDriver sidecar** rather than raw CDP/Playwright/coordinate vision in core;
- **task-scoped governed MCP tools** for Codex/Claude Code without raw driver authority;
- **per-worker browser profile/workspace/session identity**;
- **human takeover + separate operator-only secret-entry channel**;
- **persistent runaway-loop guard** that survives runtime restarts;
- **tamper-evident SHA-256 audit chain**;
- **short-lived loopback operator sessions** instead of durable credentials in the browser;
- **immutable policy versions with transactional Apply/Rollback and crash recovery**;
- **verified portable installers** without global npm/admin/PATH mutation.

> **Status: v0.4 feature baseline / v1.0 stabilization.** The core runtime, Codex/Claude harnesses, supervisor-worker protocol, production governed browser, governed MCP bridge, persistent repeat guard, live local Operator Console, versioned policy activation, and verified portable installer pipeline are implemented. The remaining stable-release work is operational diagnostics, backup/restore and migrations, final security review, release documentation/versioning, and an RC stress/soak gate.

## Quick start from source

Requires Node.js 22+ and has zero third-party Node runtime dependencies.

```bash
npm run check
npm test
node src/cli.js init
node src/cli.js submit "hello sovereign runtime" --cap demo --input '{"value":42}'
node src/cli.js run
node src/cli.js audit verify
```

`init` creates `.sovereignbot/config.json`. Runtime state under `.sovereignbot/` is ignored by Git.

For the checksum-verified portable Windows/macOS/Linux installation path, see [docs/installation.md](docs/installation.md).

## Supervisor → worker

A supervisor owns a durable plan but is not automatically allowed to execute worker tasks.

```bash
node src/cli.js plan "Ship feature X" --owner supervisor --config my-agents.json

node src/cli.js delegate <plan-id> "Research" \
  --actor supervisor --cap research --config my-agents.json

node src/cli.js delegate <plan-id> "Implement" \
  --actor supervisor --cap coding --depends <research-task-id> --review \
  --config my-agents.json

node src/cli.js run --config my-agents.json
node src/cli.js graph <plan-id> --config my-agents.json
```

The task graph persists dependencies, worker acceptance/ownership, progress, review history, attempts, results, and cancellation history. Failed dependencies block downstream harness launch.

Reviewable work stops at `awaiting_review`. An independent reviewer can request changes, retry the same resumable worker session, then approve it. See [docs/task-graph.md](docs/task-graph.md).

## Codex worker

Use an independently installed/signed-in Codex CLI; SovereignBot does not require a provider API key.

```bash
codex --version
node src/cli.js submit "Inspect and improve this repository" \
  --cap coding --config examples/codex-agent.config.json
node src/cli.js run --config examples/codex-agent.config.json
```

The adapter persists the Codex thread/session state immediately and resumes failed/review-retry work with the captured session. See [docs/codex.md](docs/codex.md).

## Claude Code worker

Use the independently installed official Claude Code CLI:

```bash
claude --version
node src/cli.js submit "Inspect and improve this repository" \
  --cap coding --config examples/claude-code-agent.config.json
node src/cli.js run --config examples/claude-code-agent.config.json
```

The adapter uses non-interactive streaming output, persists the Claude session id, resumes sessions, and maps supported progress/retry events into the durable task protocol. See [docs/claude-code.md](docs/claude-code.md).

## Governed computer and browser

Configure the driver-neutral computer core to use the bundled WebDriver sidecar:

```json
{
  "computer": {
    "allowPrivateHosts": false,
    "driver": {
      "kind": "webdriver-sidecar",
      "browser": "chrome",
      "headless": false
    }
  }
}
```

See [examples/webdriver-sidecar.config.json](examples/webdriver-sidecar.config.json). The matching WebDriver executable must be independently available. Supported profiles are `chrome`, `edge`, and `firefox`.

The production action path is deliberately layered:

```text
worker/task authority
  -> hard safety checks
  -> durable repeat observation
  -> Governor deny/allow/fail-closed decision
  -> audit decision
  -> server-held snapshot/ref
  -> private sidecar handle
  -> WebDriver/browser side effect
```

A worker cannot pair its authority with an invented task id or another worker's task.

### Structured refs, not raw browser handles

A sidecar snapshot turns raw WebDriver element ids into private random handles. `ComputerGateway` then assigns a server-held `snapshotId` and public refs. Workers receive only safe element metadata.

A new snapshot invalidates old handles. Browser reset/restart rotates the browser session lease, so old elements fail closed.

### Per-worker isolation

Every configured worker has a distinct bearer credential, browser profile directory, workspace, sidecar process/browser session, and snapshot/ref cache.

This is process/profile isolation, not VM-strength isolation. Stronger container/VM isolation can wrap the same sidecar contract and remains recommended for higher-risk workers.

### Connection-time egress checks

Browser HTTP(S) is forced through the sidecar's local proxy. The proxy resolves DNS for each connection, checks every returned address, then connects to the already-validated concrete IP.

Metadata, link-local, multicast, benchmark/documentation/reserved ranges are always denied. Ordinary private/loopback/ULA networks are denied unless `computer.allowPrivateHosts` is explicitly enabled.

This reduces DNS-rebinding/TOCTOU risk, but is not represented as equivalent to an OS network namespace. See [docs/webdriver-sidecar.md](docs/webdriver-sidecar.md).

## Governed MCP for Codex / Claude Code

A worker can opt into:

```json
"governedTools": ["computer"]
```

SovereignBot then attaches a task-scoped local stdio MCP server. The model receives structured governed tools, not raw WebDriver/CDP/Playwright authority.

The MCP caller cannot choose `agentId`, `taskId`, worker bearer tokens, or operator tokens. Secret supply remains operator-only. See [docs/governed-mcp.md](docs/governed-mcp.md).

## Human takeover and secrets

A worker may request human help; subsequent agent computer actions then fail closed. Operator authority can take/release control and run browser lifecycle operations.

Secrets use a dedicated path. Plaintext is handed directly to `typeSecret`; secret failures use fixed public/audit error messages, and credential-shaped audit fields are redacted before hash persistence.

Durable computer bearer tokens can still be bootstrapped locally for lower-level integrations:

```bash
node src/cli.js computer token <worker-id> --config <config>
node src/cli.js computer operator-token --config <config>
```

They are not returned by HTTP.

## Local operator console

Run SovereignBot on loopback:

```bash
node src/cli.js serve --config <config>
```

In a second local terminal, mint a short-lived console session:

```bash
node src/cli.js operator-session --config <config>
```

Open the printed loopback server URL at `/ui/` and paste the short-lived token.

The browser keeps this token in page memory only. It is not put in cookies, localStorage, sessionStorage, or query parameters. The durable computer operator token is never exposed to the console.

The console provides:

- overview/task inspection;
- supervisor-worker graph + durable events;
- live task/audit telemetry;
- passive worker/harness utilization and in-flight activity;
- passive computer state;
- take/release and browser lifecycle controls;
- pending secret supply;
- memory search;
- audit timeline + integrity badge;
- policy draft validation and dry-run explain;
- active policy version/hash/history;
- explicit checked Apply and verified historical Rollback.

The console is deliberately loopback-only for v1.0. Public/domain deployment is a separate later layer.

See [docs/operator-console.md](docs/operator-console.md).

## Policy

Live policy evaluation is:

**hard safety → deny rules → allow rules → deny by default**.

Rules can match harness/computer category, operation/intent, agent, target, page host, element metadata, file metadata, key input, and repeat count. Runtime hard denials are non-overridable and are not part of the editable policy document.

### Persistent repeat safety

Production repeat observations are persisted before an action may be allowed. The state file contains only SHA-256 action fingerprints and timestamps, not raw targets, URLs, text, secrets, or bearer credentials.

Restarting the runtime does not reset the active repeat window.

`repeatWindowMs` and `repeatMaxActiveFingerprints` are restart/migration-level safety settings. Live policy activation refuses targets whose effective values differ from the current active version.

### Draft / dry-run

The Policy view can load the current policy into an in-memory draft, validate it, and simulate an action with a caller-supplied `repeatCount`.

Dry-run does not call the Governor, mutate the live policy, touch `repeat-state.json`, append action-decision audit rows, or execute any action. See [docs/policy-dry-run.md](docs/policy-dry-run.md).

### Versioned Apply / Rollback

The first startup creates an immutable hash-verified policy version and active pointer. Once that version state exists, later config edits cannot silently replace the active policy.

Apply requires an explicit short-lived operator-session mutation and at least one expected dry-run check. The server independently re-runs the check before creating/activating a new version.

Activation uses an immutable version, atomic active pointer, transaction marker, runtime PolicyEngine swap, and hash-chained audit commit record. Pre-commit failures restore the previous engine/pointer; unresolved rollback leaves a recovery marker and future mutation/startup fails closed. If the audit commit succeeded but marker cleanup did not, restart reconciles only after verifying audit-chain integrity and matching transaction/version/pointer hashes.

Rollback re-activates a verified existing version through the same transaction/audit path; history is never rewritten.

See [docs/policy-activation.md](docs/policy-activation.md).

## Durable memory and workflow history

Append-only JSONL memory is scoped as `global`, `agent:<id>`, or `task:<id>`. Final results are saved to task/agent scopes; review candidates remain separate until approved.

`task-events.jsonl` reconstructs workflow/progress/review history. `audit.jsonl` stores security decisions and important transitions in a SHA-256 hash chain.

```bash
node src/cli.js audit verify
```

Editing/removing a historic audit row breaks verification.

## CI

Required regression coverage includes:

- Ubuntu + Node 22/24;
- Windows + Node 22/24;
- real Chrome + ChromeDriver sidecar/governed MCP E2E;
- real POSIX portable install;
- real Windows PowerShell portable install.

## Project principles

1. **No authority by implication.** Reasoning ability does not grant action permission.
2. **No mandatory hosted brain.** Durable state works locally.
3. **No mandatory provider API.** The core runs without model credentials.
4. **No single-agent assumption.** Planning, work, review, and specialists are first-class.
5. **No shared-context requirement.** Delegation passes explicit state/results.
6. **No silent policy fallback.** Missing/broken durable policy state fails closed.
7. **No unaudited governed action path.** Governed integrations pass through the Governor.
8. **No silent automation downgrade.** A missing production driver fails clearly rather than falling back to coordinate vision.
9. **No hidden live-policy mutation.** Policy simulation and policy activation are separate authority levels.
10. **No unverified recovery.** Crash recovery requires durable state/hash/audit evidence rather than guessing.

## Toward v1.0

The v0.4 product baseline is feature-complete after versioned policy activation. Stable v1.0 still requires operational hardening: `sovereignbot doctor`, backup/restore/export, migration/crash-recovery checks, final security review, stable version/CHANGELOG/release notes, and a release-candidate stress/soak gate.

Public Cloudflare/domain deployment, AG-UI, extra providers, and mandatory container/VM packaging are intentionally non-blocking post-v1.0 work.

See [docs/roadmap.md](docs/roadmap.md) and the v1.0 release gate in GitHub issues.

## License

MIT.
