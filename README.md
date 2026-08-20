<div align="center">

# SovereignBot

**A local-first runtime for AI coworkers: durable memory, multi-agent orchestration, governed actions, and no mandatory cloud control plane.**

[Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md) · [Security](SECURITY.md)

</div>

SovereignBot separates **intelligence** from **authority**. Your worker may be a local process, a subscription CLI, a model running elsewhere, or another agent protocol. SovereignBot keeps task state, memory, policy, routing, and the audit trail under your control.

It is inspired by the strongest idea in projects such as OpenBot — agents should not receive unrestricted access just because they can reason — but it deliberately takes a different architectural path:

- **local durable state**, with no required hosted thread/memory backend;
- **generic harness adapters**, rather than one mandatory agent protocol;
- **no mandatory metered model API** to boot or use the runtime;
- **capability-based multi-agent scheduling**;
- **fail-closed governance** before a worker is launched;
- **tamper-evident audit logs** using a SHA-256 hash chain.

> **Status: v0.1 foundation.** The core runtime is usable for local harnesses today. Browser/computer isolation and first-party Codex/Claude Code adapters are next.

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

## Use a real local harness

A command harness is any executable that:

1. reads one JSON request from stdin;
2. performs the task using whatever local/subscription agent access you choose;
3. writes JSON or text to stdout;
4. exits `0` on success.

SovereignBot never invokes command harnesses through a shell.

Try the included adapter example:

```bash
node src/cli.js submit "adapter smoke test" --cap demo --config examples/command-agent.config.json
node src/cli.js run --config examples/command-agent.config.json
```

The protocol request contains the task plus a minimal agent identity. This boundary is where Codex CLI, Claude Code, AG-UI, MCP, and other harness adapters can plug in without changing orchestration or governance.

## What v0.1 already does

### Local durable memory

Memory is append-only JSONL and scoped as `global`, `agent:<id>`, or `task:<id>`. Task results are saved automatically into both task and agent memory scopes.

### Multi-agent routing

Each agent declares capabilities, concurrency, priority, and a harness. A task can request capabilities or a preferred worker. The orchestrator schedules only compatible, available workers.

### Governed execution

Every launch becomes a governed action. Policy evaluation is:

**deny rules → allow rules → deny by default**.

Rules can currently match action category, operation, agent, target glob, and repeat count. The default config demonstrates a repeat guard that can stop an identical harness action from looping.

### Tamper-evident audit

Every policy decision and task transition is appended to `audit.jsonl`. Each row contains the previous row's hash and its own SHA-256 hash.

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
| `/tasks` | POST | Submit a task |
| `/run` | POST | Drain runnable tasks |
| `/tasks/:id/cancel` | POST | Cancel a task |
| `/memory?q=...` | GET | Inspect local memory |
| `/audit/verify` | GET | Verify audit integrity |

The v0.1 server intentionally binds to loopback and does not yet include network authentication. Read [SECURITY.md](SECURITY.md) before changing the bind address.

## Example configuration

```json
{
  "dataDir": ".sovereignbot/data",
  "bindHost": "127.0.0.1",
  "port": 7341,
  "agents": [
    {
      "id": "planner",
      "name": "Planner",
      "role": "supervisor",
      "capabilities": ["planning", "review"],
      "priority": 10,
      "harness": {
        "kind": "command",
        "command": "my-planner-adapter"
      }
    },
    {
      "id": "worker",
      "name": "Worker",
      "role": "worker",
      "capabilities": ["coding"],
      "harness": {
        "kind": "command",
        "command": "my-worker-adapter"
      }
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
5. **No silent policy fallback.** Broken or absent policy denies instead of opening access.
6. **No unaudited action path.** Governed integrations must pass through the governor.

## Next

The next milestone is not another generic chat UI. It is the layer that makes SovereignBot useful for real work:

- resumable **Codex CLI** and **Claude Code** harness adapters;
- supervisor → worker delegation with structured plans/progress;
- governed **MCP** and **computer/browser** actions;
- per-worker isolation and human take-over;
- a local operator UI for task graphs, policy, memory, and audit.

See the full [roadmap](docs/roadmap.md).

## License

MIT.
