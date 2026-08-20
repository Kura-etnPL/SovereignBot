# Supervisor → worker task graph

SovereignBot's coordination model keeps **planning authority**, **work ownership**, **review**, and **execution authority** separate.

A supervisor owns a plan. It may create delegated work and inspect the graph, but it is not automatically eligible to execute worker tasks. A worker becomes the explicit owner of a child task only after SovereignBot selects it and the governed harness launch is allowed.

## Task graph

A plan is a durable root node:

```text
plan (owner: supervisor)
├── research (worker: researcher)
├── implementation (worker: coder, depends on research)
└── reviewable report (worker: writer)
    └── review stage (reviewer: reviewer)
```

Each work task may have:

- `parentTaskId` — containment/delegation edge;
- `dependencyIds` — DAG prerequisites that must complete first;
- `supervisorAgentId` — who delegated the work;
- `assignedAgentId` / `ownerAgentId` — the worker that accepted execution;
- `requiredCapabilities` — scheduler constraints;
- `review` — optional independent approval requirements;
- `progress` — latest structured progress snapshot;
- `harnessState` — resumable adapter state such as a Codex session id.

`GET /tasks/:id/graph` returns nodes, parent/dependency edges, status counts, and the durable task event history for a future operator UI.

## Supervisor boundary

Agents with `role: "supervisor"` are excluded from normal worker scheduling by default, even if they advertise the same capabilities. A task must explicitly set `allowSupervisorExecution: true` to make a supervisor eligible as an executor.

This prevents "the brain" from silently becoming the worker just because it can do the work. Planning/inspection does not imply action authority.

## Create and delegate

Create a plan:

```text
POST /plans
{
  "title": "Ship feature X",
  "ownerAgentId": "supervisor"
}
```

Delegate a child:

```text
POST /tasks/<plan-id>/delegate
{
  "actorAgentId": "supervisor",
  "task": {
    "title": "Implement X",
    "requiredCapabilities": ["coding"],
    "dependencyIds": []
  }
}
```

The delegating actor must be a configured supervisor and must own the parent task.

## Dependency semantics

A queued task runs only after every dependency reaches `completed`.

- unfinished dependency → task waits;
- failed/blocked/cancelled dependency → downstream task becomes `blocked` before its harness is launched;
- missing dependency → fail closed and block.

This makes causality explicit rather than relying on timing or a supervisor remembering what should run next.

## Acceptance and ownership

After a compatible worker is selected, SovereignBot first asks the Governor whether its harness may launch. Only an allowed launch produces `task.accepted`, assigns `ownerAgentId`, and moves the task to `running`.

A denied launch never becomes an accepted task.

## Progress events

Workers can emit structured progress with an idempotency key:

```text
POST /tasks/<task-id>/progress
{
  "actorAgentId": "worker",
  "eventId": "progress:compile:1",
  "percent": 40,
  "message": "compiling"
}
```

Re-sending the same event id does not append another event or overwrite the latest progress snapshot. Event ids are bound to one task/event type; accidental reuse elsewhere is rejected.

Task events are append-only JSONL under the runtime data directory and survive restarts.

## Review stage

A work task can request review:

```json
{
  "review": {
    "required": true,
    "requiredCapabilities": ["review"],
    "independent": true
  }
}
```

A successful worker result becomes `candidateResult` and the task moves to `awaiting_review`. It is **not** published as the final task result yet.

Review endpoint:

```text
POST /tasks/<task-id>/review
{
  "reviewerAgentId": "reviewer",
  "eventId": "review:1",
  "decision": "approve",
  "notes": "looks good"
}
```

or:

```json
{
  "reviewerAgentId": "reviewer",
  "eventId": "review:1",
  "decision": "changes_requested",
  "notes": "add evidence for the second claim"
}
```

When independent review is enabled, the executing worker cannot approve its own result. A reviewer must have all configured review capabilities.

`changes_requested` is retryable. Review history remains durable across attempts; retry clears the candidate result while preserving harness continuation state, so a resumable worker can continue the same session.

## Retry idempotency

A failed, blocked, cancelled, or changes-requested task can be retried. The attempt counter increments once and the task returns to `queued`.

If the retry request is accidentally repeated while that retried attempt is already queued/accepted/running, SovereignBot returns the existing task instead of incrementing another attempt.

Completed work is never silently rerun by the retry endpoint.

## Cancellation propagation

Cancelling a plan cascades by default to every non-terminal descendant. Running children receive an abort signal; queued/reviewing children are marked cancelled without execution.

Already completed/failed/blocked descendants keep their terminal history rather than being rewritten.

Use `cascade: false` only when intentionally cancelling one node.

## Plan aggregation

Once every descendant is terminal, the plan owner can aggregate:

```text
POST /tasks/<plan-id>/aggregate
{
  "actorAgentId": "supervisor"
}
```

- every delegated task completed → plan `completed`, outcome `success`;
- any delegated task failed/blocked/cancelled → plan `failed`, outcome `partial_failure`;
- any task still active → no terminal plan transition; the response includes active task ids and status counts.

The aggregate includes each descendant's status, assigned worker, result, and error so the supervisor can reason over real worker outcomes rather than shared hidden context.

## Durable history vs security audit

SovereignBot keeps two different records on purpose:

- **task events** describe workflow history, progress, review, ownership, and graph transitions;
- **audit events** prove security-sensitive decisions and important state transitions.

The task event stream is designed for orchestration/UI reconstruction. The audit stream remains SHA-256 hash chained for tamper detection.
