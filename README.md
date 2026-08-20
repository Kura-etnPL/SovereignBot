<div align="center">

# SovereignBot

**A local-first runtime for AI coworkers: durable memory, supervisor/worker orchestration, governed actions, and no mandatory cloud control plane.**

[Architecture](docs/architecture.md) · [Task graph](docs/task-graph.md) · [Codex](docs/codex.md) · [Claude Code](docs/claude-code.md) · [Roadmap](docs/roadmap.md) · [Security](SECURITY.md)

</div>

SovereignBot separates **intelligence** from **authority**. A worker may be a local process, an independently authenticated Codex/Claude Code CLI, a model running elsewhere, or another agent protocol. SovereignBot keeps task state, memory, policy, routing, review, and the audit trail under your control.

It is inspired by the strongest idea in projects such as OpenBot — agents should not receive unrestricted access just because they can reason — but deliberately takes a different architectural path:

- **local durable state**, with no required hosted thread/memory backend;
- **generic harness adapters**, rather than one mandatory agent protocol;
- **no mandatory metered model API** to boot or use the runtime;
- **resumable Codex and Claude Code workers** using locally installed CLIs;
- **supervisor → worker task graphs**, with explicit ownership and dependency edges;
- **independent review stages**, without sharing one hidden context;
- **fail-closed governance** before a worker is launched;
- **tamper-evident audit logs** using a SHA-256 hash chain.

> **Status: v0.2.** The sovereign core, resumable Codex + Claude Code workers, and durable supervisor/worker coordination protocol are implemented. Fine-grained governed MCP/computer actions and the operator UI are next.

## Quick start

Requires Node.js 22+ and has zero third-party runtime dependencies.

```bash
npm run check
npm test
node src/cli.js init
node src/cli.js submit "hello sovereign runtime" --cap demo --input '{"value":42}'
node src/cli.js run
node src/cli.js status
node src/cli.js audit verify
```

`init` creates `.sovereignbot/config.json` with a safe demo worker and an explicit allow rule for that worker. Runtime state stays under `.sovereignbot/` and is ignored by Git.

## Supervisor → worker workflow

A supervisor owns a durable plan but is **not** automatically eligible to execute worker tasks. It delegates focused child tasks; workers receive explicit ownership only after policy allows their harness launch.

```bash
node src/cli.js plan "Ship feature X" --owner supervisor --config my-agents.json

node src/cli.js delegate <plan-id> "Research the change" \
  --actor supervisor \
  --cap research \
  --config my-agents.json

node src/cli.js delegate <plan-id> "Implement the change" \
  --actor supervisor \
  --cap coding \
  --depends <research-task-id> \
  --review \
  --config my-agents.json

node src/cli.js run --config my-agents.json
node src/cli.js graph <plan-id> --config my-agents.json
```

The graph persists parent/delegation edges, dependency edges, worker acceptance, structured progress, review history, retry attempts, results, and cancellation history. A failed dependency blocks downstream work before its harness launches.

Reviewable work stops at `awaiting_review` with a candidate result. An independent reviewer may approve it or request changes; a resumable Codex or Claude Code worker receives the latest requested changes when the task continues its existing session. See [docs/task-graph.md](docs/task-graph.md).

## Use Codex as a worker

If Codex CLI is independently installed and signed in, SovereignBot can launch that local executable directly. SovereignBot itself does not need to hold a provider API key.

```bash
codex --version

node src/cli.js submit "Inspect this repository and identify one high-value fix" \
  --cap coding \
  --config examples/codex-agent.config.json
node src/cli.js run --config examples/codex-agent.config.json
```

When Codex emits `thread.started`, SovereignBot immediately persists the session id. If the turn later fails, `retry` resumes the captured session instead of silently starting fresh.

See [docs/codex.md](docs/codex.md) for Windows discovery, configuration, failure handling, and the v0.2 governance boundary.

## Use Claude Code as a worker

If the official Claude Code CLI is independently installed and authenticated, SovereignBot can launch its native `claude` executable directly.

```bash
claude --version

node src/cli.js submit "Inspect this repository and implement one high-value fix" \
  --cap coding \
  --config examples/claude-code-agent.config.json
node src/cli.js run --config examples/claude-code-agent.config.json
```

The adapter uses Claude Code print mode with streaming JSON. It persists the `system/init` session id immediately, resumes with `--resume`, and maps supported Claude Code task-progress/API-retry events into SovereignBot's durable progress protocol.

See [docs/claude-code.md](docs/claude-code.md) for installation discovery, authentication/distribution boundaries, configuration, live progress, and permissions.

## Use a generic local harness

A command harness is any executable that reads one JSON request from stdin, performs the task, writes JSON/text to stdout, and exits `0` on success. SovereignBot invokes it with `shell: false`.

```bash
node src/cli.js submit "adapter smoke test" --cap demo --config examples/command-agent.config.json
node src/cli.js run --config examples/command-agent.config.json
```

This boundary is where future AG-UI, MCP, or other worker adapters can plug in without changing orchestration or governance.

## What SovereignBot already does

### Local durable memory

Memory is append-only JSONL and scoped as `global`, `agent:<id>`, or `task:<id>`. Final task results are saved into task and agent scopes; review candidates remain separate until approved.

### Supervisor/worker task graph

Plans, child tasks, dependencies, ownership, progress, review, retries, and cancellation are durable. Supervisors are excluded from normal worker scheduling unless a task explicitly opts into supervisor execution. Planning ability does not silently become action authority.

Task-state writes are serialized and applied against the latest persisted state, so cancellation and worker completion cannot overwrite each other with stale snapshots. Task-event and security-audit appends are serialized independently.

### Resumable harness state

Harnesses can persist continuation state while a task is still running. Codex saves `thread.started`; Claude Code saves `system/init.session_id`. Retry preserves that state while clearing the previous result/error, so failed long-running work can continue rather than restart.

### Governed execution

Every harness launch becomes a governed action. Policy evaluation is:

**deny rules → allow rules → deny by default**.

Rules can match action category, operation, agent, target glob, and repeat count. Config examples demonstrate repeat guards that stop identical harness-launch loops.

For Codex and Claude Code, v0.2 governs the decision to launch/resume the worker. It does **not** yet intercept every internal shell/MCP/browser/file/network action; read [SECURITY.md](SECURITY.md) before granting workers broad local permissions.

### Durable workflow history + tamper-evident audit

SovereignBot keeps two records with different jobs:

- `task-events.jsonl` reconstructs orchestration history, progress, ownership, and review;
- `audit.jsonl` records security-sensitive decisions and important transitions in a SHA-256 hash chain.

```bash
node src/cli.js audit verify
```

If a historic audit row is edited or removed, verification fails.

### Local control API

```bash
node src/cli.js serve
```

Default: `http://127.0.0.1:7341`

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Runtime health |
| `/agents` | GET | Configured workers |
| `/tasks` | GET | Task state |
| `/tasks` | POST | Submit standalone work |
| `/plans` | POST | Create a supervisor-owned plan |
| `/run` | POST | Drain runnable tasks |
| `/tasks/:id/graph` | GET | Nodes, edges, status counts, durable events |
| `/tasks/:id/events` | GET | Task event history |
| `/tasks/:id/delegate` | POST | Delegate child work |
| `/tasks/:id/progress` | POST | Idempotent structured worker progress |
| `/tasks/:id/review` | POST | Approve or request changes |
| `/tasks/:id/aggregate` | POST | Aggregate a terminal plan |
| `/tasks/:id/retry` | POST | Retry while preserving harness continuation state |
| `/tasks/:id/cancel` | POST | Cancel a task/plan; cascades by default |
| `/memory?q=...` | GET | Inspect local memory |
| `/audit/verify` | GET | Verify audit integrity |

The v0.2 server intentionally binds to loopback and does not yet include network authentication. Read [SECURITY.md](SECURITY.md) before changing the bind address.

## Example multi-agent configuration

```json
{
  "dataDir": ".sovereignbot/data",
  "agents": [
    {
      "id": "supervisor",
      "name": "Supervisor",
      "role": "supervisor",
      "capabilities": ["planning"],
      "harness": { "kind": "command", "command": "my-supervisor-adapter" }
    },
    {
      "id": "codex-worker",
      "name": "Codex Worker",
      "role": "worker",
      "capabilities": ["coding"],
      "harness": { "kind": "codex", "cwd": "." }
    },
    {
      "id": "claude-worker",
      "name": "Claude Code Worker",
      "role": "worker",
      "capabilities": ["coding", "review"],
      "harness": { "kind": "claude-code", "cwd": "." }
    }
  ],
  "policy": {
    "rules": [
      {
        "id": "stop-repeat-loop",
        "effect": "deny",
        "match": { "category": "harness", "operation": "run", "repeatAtLeast": 10 }
      },
      {
        "id": "allow-owned-harnesses",
        "effect": "allow",
        "match": { "category": "harness", "operation": "run" }
      }
    ]
  }
}
```

## Project principles

1. **No authority by implication.** Being selected as an agent does not imply permission to act.
2. **No mandatory hosted brain.** Durable state must work locally.
3. **No mandatory provider API.** The core runs with zero model credentials.
4. **No single-agent assumption.** Planning, execution, review, and specialist workers are first-class.
5. **No shared-context requirement.** Delegation passes explicit task state/results rather than assuming every worker shares one prompt history.
6. **No silent policy fallback.** Broken or absent policy denies instead of opening access.
7. **No unaudited governed action path.** Integrations declared governed must pass through the governor.

## Next

The next milestones focus on safe real-world action, not another generic chat UI:

- governed **MCP** and **computer/browser** actions;
- per-worker isolation and human take-over;
- harness health/leases;
- AG-UI/MCP worker adapters where they add value;
- a local operator UI for task graphs, policy, memory, and audit.

See the full [roadmap](docs/roadmap.md).

## License

MIT.
