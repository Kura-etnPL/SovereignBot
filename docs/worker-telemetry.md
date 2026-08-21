# Worker and harness telemetry

SovereignBot exposes passive worker utilization in the local operator console without pinging provider CLIs or consuming model quota.

## What `in-flight` means

`inFlightHarnessCount` measures actual calls currently inside the unified SovereignBot harness `run()` boundary.

That means it covers the real execution lifetime of:

- Echo/demo harnesses;
- generic command harnesses;
- Codex CLI harnesses;
- Claude Code harnesses;
- governed MCP bridge setup/execution/cleanup around those provider harnesses.

The meter increments immediately before entering the harness boundary and decrements in `finally`, so success, failure, cancellation, and thrown errors all release capacity.

It is intentionally not inferred from durable `task.status`. A persisted `running` task and an in-process provider execution are related but not identical concepts.

## No provider probes

Reading `/operator/workers` does not:

- launch Codex or Claude Code;
- call a provider API;
- start a command harness;
- open MCP;
- start a browser;
- run a health probe;
- alter task state.

The snapshot reads existing local runtime/task/event state only.

## Runtime isolation

Harness activity is keyed by the configured agent object identity, not only by string `agentId`.

Two SovereignBot runtimes embedded in the same Node process may both have an agent named `worker`; their utilization counters remain independent.

The live operator stream subscribes only to the current runtime's agent identities.

## Snapshot fields

Each worker record may include:

- id/name/role;
- harness kind;
- declared capabilities;
- max concurrency;
- in-flight harness count;
- remaining harness capacity;
- accepted/running task ids;
- review count;
- compatible and currently runnable queued task counts;
- resumable-session task **count**;
- latest worker task-event type/task id/timestamp.

The snapshot deliberately does not include:

- `harnessState`;
- Codex thread/session ids;
- Claude session ids;
- task input/results/candidate results;
- progress messages/data;
- model context;
- provider credentials.

A resumable provider session is represented only as a count/indicator.

## Supervisor execution

Queue compatibility uses the same scheduler rules as normal dispatch. A supervisor is not counted as compatible worker capacity unless the queued task explicitly enables supervisor execution.

## Live updates

The in-process harness meter publishes a minimal signal:

```json
{
  "source": "worker",
  "type": "harness.activity",
  "agentId": "worker",
  "inFlightHarnessCount": 1,
  "at": "..."
}
```

No provider/session/task payload accompanies the signal. The operator console uses it only as an invalidation trigger and re-reads the authenticated `/operator/workers` snapshot.

Subscriber failures are isolated and cannot fail harness execution.
