# Governed computer layer

SovereignBot separates **agent intelligence**, **action authority**, **browser implementation**, and **human/operator authority**.

The orchestration core does not depend on Playwright, CDP, coordinate vision, or a browser vendor. v0.3 now includes a production **W3C WebDriver sidecar** behind the same driver-neutral contract used by deterministic tests.

See [webdriver-sidecar.md](webdriver-sidecar.md) for the concrete production driver.

## Authority path

A production worker action follows this path:

```text
worker
  -> bearer token for this exact worker
  -> task exists + status=running + assignedAgentId=this worker
  -> hard runtime safety checks
  -> Governor deny/allow/fail-closed policy
  -> hash-chained audit decision
  -> private driver/workspace side effect
  -> outcome audit
```

Possessing a worker token is therefore insufficient without a currently running task owned by that worker.

Hard runtime refusals (for example stale refs or active human control) cannot be overridden by a broad policy allow rule.

## Per-agent identity and storage

For each configured agent SovereignBot creates a separate computer identity under the runtime data directory:

```text
computers/
  operator-token
  state.json
  <base64url-worker-key>/
    token
    profile/
    workspace/
```

The encoded key is collision-free for arbitrary UTF-8 agent ids and is also used for durable state keys, avoiding special JavaScript object names such as `__proto__`.

Each worker has its own:

- computer bearer token;
- browser profile;
- workspace;
- server-held snapshot cache;
- sidecar/browser session when the production driver is enabled.

The operator token is a separate authority class and is never accepted as an agent token.

## Snapshot/ref model

Workers never supply a trusted browser backend handle.

1. The driver snapshots visible structured elements.
2. Private backend/WebDriver ids stay in the sidecar/core.
3. SovereignBot assigns an opaque `snapshotId` and public refs.
4. The worker receives only safe metadata such as ref, role, name, and input type.
5. Click/type/key must reference the current snapshot/ref.

A stale snapshot, invented ref, or missing ref is refused before driver side effects.

The production sidecar adds another private **browser session lease**. A reset/restart rotates the lease and invalidates every old driver handle.

## Navigation and network boundary

The core validates navigation intent before policy:

- only `http`/`https`;
- no embedded URL credentials;
- known cloud metadata targets always denied;
- private/loopback targets denied by default.

The WebDriver sidecar adds connection-time enforcement: browser HTTP(S) is sent through a loopback egress proxy that resolves DNS itself, checks every returned IP, and connects to the already-validated IP. This closes the obvious hostname-check → DNS-rebind → connect gap.

Always-blocked address classes stay denied even when `computer.allowPrivateHosts` is enabled. The option only opens ordinary private/loopback networks for explicitly trusted local deployments.

This proxy is not represented as an OS network namespace. Container/VM/firewall deployment remains available as stronger defense in depth.

## Workspace boundary

File tools are governed independently:

- `list_files`
- `read_file`
- `write_file`

Paths must remain beneath the worker's workspace. Absolute paths, traversal, NUL paths, and symlink/junction escapes are refused.

File contents themselves do not enter policy/audit metadata.

## Human takeover

A worker can request help, moving durable control state to `requested`. Agent computer actions then fail closed.

The operator may take and release control:

```text
agent -> requested -> human -> agent
```

While `human` owns control, agent actions are refused immediately rather than queued.

## Secret channel

A worker requests a secret against a current snapshot/ref. Stored request metadata contains only the request id, task id, label, snapshot id, ref, and timestamp.

The operator-only supply route sends plaintext directly to `typeSecret`. Plaintext is not intentionally inserted into:

- task state/events;
- memory;
- policy context;
- normal audit payloads.

Computer secret failures use fixed public/audit error messages. The audit layer also redacts credential-shaped fields before hashing/persistence.

## Authenticated computer API

Worker routes use the worker bearer token and a real running `taskId`:

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

Operator-only routes use the independent operator token:

```text
GET  /computers
GET  /computers/:agentId/control
GET  /computers/:agentId/health
POST /computers/:agentId/control/take
POST /computers/:agentId/control/release
POST /computers/:agentId/lifecycle/start
POST /computers/:agentId/lifecycle/stop
POST /computers/:agentId/lifecycle/reset
POST /computers/:agentId/secrets/:requestId/supply
```

Tokens are bootstrapped only through local CLI commands:

```bash
node src/cli.js computer token <agent-id> --config <config>
node src/cli.js computer operator-token --config <config>
```

The HTTP API does not expose them.

## Driver contract

The core driver contract remains small:

```text
snapshot()
navigate(url)
click({ element })
type({ element, text })
key({ element?, key })
scroll(...)
typeSecret({ element, text })
```

Production v0.3 adds optional health/start/stop/reset lifecycle methods. The bundled WebDriver sidecar implements them.

`MemoryComputerDriver` remains only for deterministic contract tests; a configured production sidecar never silently falls back to visual automation or the memory driver.

## Real-browser validation

CI runs the normal suite on Ubuntu/Windows with Node 22/24 and a separate real-browser job on Ubuntu 24.04 with Chrome + ChromeDriver.

The real-browser test proves:

```text
navigate
-> structured snapshot
-> type normal text
-> type secret through dedicated path
-> click
-> observe page result
-> reset browser
-> refuse old lease
```

No external site is required for that test.

## Important integration boundary

The computer layer is a governed capability service. Merely configuring it does not magically rewrite the internal browser/shell tools of Codex or Claude Code.

A worker should receive computer access through a controlled adapter/MCP tool that calls the `/computers/...` API with that worker's token and current task id. Giving the model raw WebDriver/CDP access would bypass the whole authority boundary and is not an acceptable integration.
