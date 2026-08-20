# Production WebDriver computer sidecar

SovereignBot v0.3 includes a production structured browser driver behind the governed-computer boundary. It uses the **W3C WebDriver protocol** and keeps browser implementation details outside the orchestration core.

It does not depend on Playwright, CDP APIs, or coordinate-only vision.

## Architecture

```text
worker
  -> SovereignBot agent bearer token
  -> running-task ownership check
  -> ComputerGateway hard-safety + Governor
  -> audit decision
  -> private SidecarComputerDriver
  -> authenticated loopback sidecar
  -> WebDriver
  -> browser profile for this worker
             |
             +-> local egress proxy -> resolved/validated destination IP
```

There are three unrelated credentials/identities on purpose:

1. the worker computer bearer token authenticates a worker to SovereignBot;
2. the operator token authorizes human control/lifecycle/secret supply;
3. a fresh random sidecar transport token authenticates the private core↔sidecar channel.

The sidecar transport token is created when the process starts and is never exposed by the public computer API.

## Configuration

```json
{
  "computer": {
    "allowPrivateHosts": false,
    "driver": {
      "kind": "webdriver-sidecar",
      "browser": "chrome",
      "headless": false,
      "startupTimeoutMs": 30000,
      "requestTimeoutMs": 30000
    }
  }
}
```

Supported browser profiles are currently:

- `chrome`
- `edge`
- `firefox`

The matching WebDriver executable must be independently installed or discoverable in `PATH`. CI exercises the Chrome + ChromeDriver path against a real browser.

Optional advanced fields:

- `browserBinary`: explicit browser executable;
- `webdriverCommand`: explicit driver executable;
- `webdriverArgs`: driver args (`{port}` is replaced with the private loopback port);
- `webdriverUrl`: an already-running **loopback HTTP** WebDriver endpoint;
- `sidecarCommand` / `sidecarArgs`: replace the bundled sidecar process while keeping the same protocol.

Remote WebDriver URLs are rejected by configuration validation. If a remote/VM driver is added later, it should use an authenticated transport designed for that deployment rather than turning raw WebDriver into a network service.

## Browser profile isolation

Each configured worker receives its own durable computer root:

```text
computers/<collision-free-worker-key>/
  token
  profile/
  workspace/
```

The WebDriver sidecar starts the browser with that worker's `profile/`. Another worker receives a different sidecar process, profile, workspace, bearer token, server-held snapshot cache, and browser session lease.

This is process/profile isolation, not a claim that each browser is already inside a separate VM. A later deployment can place the same sidecar contract inside a container or VM without changing the Governor or task graph.

## Structured snapshots and private element handles

The sidecar executes a small in-page snapshot routine that collects visible interactive/semantic elements and derives:

- role;
- accessible-ish name from ARIA/label/placeholder/title/text sources;
- input type;
- disabled state.

The raw WebDriver element id never reaches the worker.

```text
WebDriver element id
   -> sidecar random handle
      -> private driver object
         -> SovereignBot snapshot ref (e1, e2, ...)
            -> worker
```

`ComputerGateway` returns only safe public metadata. A click/type action must carry the current SovereignBot `snapshotId` and ref. SovereignBot resolves that ref to its private sidecar handle.

A new snapshot invalidates previous sidecar handles. A browser session reset/restart changes the browser **session lease**, making every old handle unusable even if a caller still has a stale SovereignBot object in memory.

## Network egress boundary

Chrome/Edge/Firefox are configured to send HTTP(S) traffic through a private loopback proxy owned by the sidecar.

For each connection the proxy:

1. receives the destination hostname;
2. resolves DNS itself;
3. classifies every returned address;
4. refuses blocked classes;
5. connects directly to the already-validated IP rather than resolving the hostname again.

Always-blocked classes include cloud metadata/link-local targets, multicast, benchmark/documentation/reserved ranges, and equivalent IPv6 ranges. By default RFC1918, loopback, CGNAT and IPv6 ULA are blocked too.

`computer.allowPrivateHosts: true` may allow ordinary private/loopback destinations for explicitly trusted local deployments, but it does not open the always-blocked classes.

Chrome additionally disables QUIC and non-proxied WebRTC UDP; Firefox disables peer connection in the sidecar profile.

### Boundary of this protection

The egress proxy is materially stronger than validating the URL string in the core because it checks the address at the actual connection boundary and avoids the obvious DNS re-resolution TOCTOU.

It is still **not an OS network namespace**. A hardened hostile-browser deployment can put the same sidecar inside a container/VM/firewall boundary for defense in depth. SovereignBot does not represent the user-space proxy as equivalent to kernel-enforced egress isolation.

## Running-task ownership

The production runtime wraps the raw gateway with `TaskBoundComputerGateway`.

A normal worker computer action therefore needs all three:

1. the bearer token for that exact worker;
2. a task that currently exists in `running` state and is assigned to that worker;
3. an allowed Governor decision (plus all non-overridable hard-safety checks).

A leaked worker token alone cannot be used with an invented task id or another worker's task.

Low-level gateway tests can explicitly disable task binding, but production `createRuntime()` enables it by default.

## Human control and secret supply

The operator token owns privileged routes:

```text
GET  /computers/:agentId/health
GET  /computers/:agentId/control
POST /computers/:agentId/control/take
POST /computers/:agentId/control/release
POST /computers/:agentId/lifecycle/start
POST /computers/:agentId/lifecycle/stop
POST /computers/:agentId/lifecycle/reset
POST /computers/:agentId/secrets/:requestId/supply
```

When human control is active, worker actions fail immediately rather than being queued.

Secret text is sent only to the dedicated `typeSecret` route. The public API returns a generic error if secret input fails, and the audit sanitizer removes credential-shaped fields before a row is hashed and written. Secret-operation error text is replaced with a fixed message.

## Local token bootstrap

Bearer tokens are intentionally not retrievable through HTTP.

Use the local CLI:

```bash
node src/cli.js computer token browser-worker --config examples/webdriver-sidecar.config.json
node src/cli.js computer operator-token --config examples/webdriver-sidecar.config.json
```

Treat both outputs as credentials.

## Lifecycle and leases

The operator can inspect sidecar health and start/stop/reset the browser through authenticated routes. Lifecycle requests and outcomes are audited.

Health includes a process lease and browser session lease. The core verifies the process lease returned by the authenticated sidecar. Side-effecting operations are **not automatically retried** after transport failure because a click or submit may have reached the browser even when the response was lost.

Recovery requires a fresh sidecar/session and a fresh snapshot.

## CI

Normal tests run on:

- Ubuntu + Node 22
- Ubuntu + Node 24
- Windows + Node 22
- Windows + Node 24

A separate `browser-e2e` job on GitHub `ubuntu-24.04` launches real Chrome + ChromeDriver and verifies:

```text
navigate
-> structured snapshot
-> normal type
-> secret type
-> click
-> observe resulting state
-> reset
-> old lease is refused
```

The browser E2E does not require an external website: it uses a local fixture and enables private hosts only for that isolated test.

## Harness integration

The governed computer service is a capability surface. A Codex/Claude Code harness does **not automatically intercept or replace every internal browser/shell tool** merely because the sidecar is configured.

To give a worker governed browser access, expose the `/computers/...` capability to that worker through a controlled adapter/MCP tool that sends its worker token and current task id. That bridge is the next integration layer; it must not bypass the gateway by handing raw WebDriver/CDP access to the model.
