# Governed computer core

SovereignBot's governed-computer layer separates **agent intelligence**, **action authority**, **driver implementation**, and **human/operator authority**.

The core does not assume Playwright, CDP, coordinate-only vision, or one browser vendor. A concrete driver/sidecar implements the low-level computer contract. SovereignBot owns the policy, refs, workspace boundary, control state, tokens, secret channel, and audit trail around it.

> Current status: the governance core and deterministic in-memory driver are implemented. A production browser/computer sidecar is a follow-up. Do not treat the Memory driver as a real browser runtime.

## Per-agent isolation

For each configured agent SovereignBot creates a private computer root under the runtime data directory:

```text
computers/
  operator-token
  state.json
  <agent>/
    token
    profile/
    workspace/
```

Each agent receives a distinct random bearer token. The operator token is separate and has a different authority class.

- **agent token**: may call governed actions only for that exact agent id;
- **operator token**: may inspect/take/release human control and supply a requested secret;
- an agent token is never accepted as an operator token.

Token files are runtime state and must never be committed.

## Action path

A normal action follows one path:

```text
worker request
  -> authenticate worker token
  -> derive trusted server context
  -> apply hard runtime safety invariants
  -> Governor policy decision
  -> append decision to hash-chained audit
  -> invoke driver/workspace side effect only when allowed
  -> append success/failure audit event
```

A missing allow rule denies. Deny rules run before allow rules. Runtime hard denials such as stale refs or active human control cannot be overridden by a broad administrator allow rule.

## Snapshot and ref model

Element actions do not trust the worker to describe the element it wants to operate.

1. The driver returns a snapshot containing public refs plus any private backend handles.
2. SovereignBot validates the refs and assigns its own opaque `snapshotId`.
3. Only safe element metadata is returned to the worker (`ref`, role, name, type).
4. Private driver handles remain server-side.
5. `click`, `type`, and element-targeted `key` require the current `snapshotId` and a ref present in that server-held snapshot.

A stale snapshot id, invented ref, or missing snapshot is a hard refusal and is audited. Navigation invalidates the cached snapshot.

This prevents an agent from bypassing policy by claiming that an arbitrary backend handle is a harmless button.

## Navigation guard

Before policy or driver execution, the core validates navigation targets:

- only `http` and `https`;
- no credentials embedded in the URL;
- known cloud metadata hosts are always denied;
- literal loopback/private/link-local targets are denied by default;
- `computer.allowPrivateHosts: true` may relax the ordinary private-host check for trusted local deployments, but never the metadata-host block.

Audit output removes URL credentials, query strings, and fragments so a token passed in a query parameter is not copied into the audit trail.

### Important egress limitation

The core preflight does **not** resolve DNS and does not claim to solve DNS rebinding, proxy indirection, or all network-namespace escape cases. A production driver/sidecar must add its own network egress enforcement at the connection/container/VM boundary and must revalidate the resolved destination.

## Workspace boundary

Every agent gets its own workspace directory. File operations are governed separately:

- `list_files`
- `read_file`
- `write_file`

Paths must be relative and remain under that agent's workspace. The workspace layer rejects:

- absolute paths;
- `..` escape;
- NUL-containing paths;
- symbolic-link/junction traversal through a workspace path.

File content is passed only to the execution callback and is not added to policy/audit metadata.

## Human take-over

A worker may request human help. That immediately changes the durable control mode to `requested` and freezes subsequent agent computer actions.

The operator can then take explicit control:

```text
requested -> human -> agent
```

While control is `human`, worker actions fail closed rather than queueing for later. Control state is durable across SovereignBot restarts.

Events include:

- `computer.help_requested`
- `computer.control_taken`
- `computer.control_released`

## Secret-entry channel

Secrets do not travel through ordinary task text or the normal `type` policy payload.

A worker requests a secret against a current server-held snapshot/ref. SovereignBot stores only:

- request id;
- task id;
- label;
- snapshot id;
- element ref;
- timestamp.

The request pauses agent computer actions. An operator may supply the value through the operator-only endpoint. The plaintext is handed directly to the driver's `typeSecret` call and is never added to:

- task state;
- task events;
- memory;
- policy context;
- audit payload.

Audit records the request, operator identity label, ref, and character count only. If the snapshot is no longer current (for example after restart), supply fails and asks the operator to re-establish a fresh safe target.

## Token-protected local API

Agent actions use the agent's token:

```text
POST /computers/:agentId/snapshot
POST /computers/:agentId/navigate
POST /computers/:agentId/click
POST /computers/:agentId/type
POST /computers/:agentId/key
POST /computers/:agentId/scroll
POST /computers/:agentId/files/list
POST /computers/:agentId/files/read
POST /computers/:agentId/files/write
POST /computers/:agentId/help
POST /computers/:agentId/secret-request
```

Every request sends:

```text
Authorization: Bearer <agent-computer-token>
```

The action body includes a `taskId` so policy/audit can bind the action to work.

Operator-only routes use the distinct operator token:

```text
GET  /computers
GET  /computers/:agentId/control
POST /computers/:agentId/control/take
POST /computers/:agentId/control/release
POST /computers/:agentId/secrets/:requestId/supply
```

Operator route bodies use `actorId` as an audit label. Possession of the operator bearer token is the actual authorization check.

## Driver contract

A production driver is expected to implement:

```text
snapshot()
navigate(url)
click({ element })
type({ element, text })
key({ element?, key })
scroll({ deltaX?, deltaY? })
typeSecret({ element, text })
```

The driver receives the private element object selected from SovereignBot's server-held snapshot, not an arbitrary backend handle supplied by the worker.

`MemoryComputerDriver` exists only for deterministic tests and driver-contract development. If no production driver is injected, browser/computer actions fail clearly rather than silently downgrading to a weaker automation method.

## What remains before issue #5 is complete

The governed core is deliberately only the first half. A production-grade implementation still needs:

- a real structured browser/computer sidecar/driver;
- network namespace/egress controls including resolved-address checks;
- process/container lifecycle isolation for browser profiles;
- authenticated driver transport and health/lease semantics;
- end-to-end tests against a real browser target;
- optional stronger container/VM sandboxing without making self-hosting a virtue by itself.

Issue #5 stays open until those pieces are implemented and validated.
