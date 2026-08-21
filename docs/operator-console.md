# Local operator console

SovereignBot v0.4 includes a dependency-free local operator console for inspecting the runtime and performing explicit operator-only computer actions.

The console is intentionally a view/controller for the existing runtime. It is **not** a second authority path.

## Start it

Start the normal runtime server:

```bash
sovereignbot serve --config .sovereignbot/config.json
```

The console is served at:

```text
http://127.0.0.1:7341/ui/
```

In another local terminal, mint a short-lived console session:

```bash
sovereignbot operator-session --ttl-minutes 30 --config .sovereignbot/config.json
```

Paste the printed session token into the console login form.

The token is held only in the page's JavaScript memory. It is not written to `localStorage`, `sessionStorage`, cookies, or the URL. Refreshing the page therefore requires entering a valid session again.

Use **Revoke session** when finished.

## What the console can show

- task state and recent tasks;
- supervisor/worker task graphs and events;
- configured workers/agents;
- passive computer lifecycle/control state;
- pending human secret requests;
- local memory search;
- audit-chain integrity and recent audit rows.

## Operator actions

The first v0.4 milestone allows deliberate operator actions:

- take human control;
- release control back to the agent;
- start/stop/reset a managed computer;
- supply a pending requested secret.

The UI does not expose raw WebDriver/CDP/Playwright handles, browser debug ports, worker bearer tokens, or the durable computer operator token.

## Session boundary

The durable computer operator credential remains inside runtime state. The browser receives only a separate short-lived operator-console capability.

SovereignBot stores each active console session as one file under:

```text
<dataDir>/operator-sessions/<sha256(token)>.json
```

The raw token is not stored. Session files contain only version/timestamps/label metadata. Per-session files also avoid a shared read-modify-write race when a running server revokes one session while a separate local CLI process creates another.

## Loopback only

The built-in console and `/operator/*` API are enabled only when SovereignBot itself is configured on loopback (`127.0.0.1`, `localhost`, or `::1`) and the request arrives from loopback.

Binding the main server to a LAN/public interface does **not** automatically publish the operator console. A future remote deployment mode would need its own authenticated transport and threat model.

## Cross-origin protection

Operator mutations validate browser `Origin` when present and reject a mismatched origin. The page also uses a restrictive Content Security Policy:

- scripts/styles/connect: same origin only;
- no default external content;
- no embedding in frames;
- no external form target/base URI.

The short-lived bearer is sent in the `Authorization` header, not a cookie or query string.

## Secret supply

A worker can request a secret but cannot supply one itself. The console displays the request label/task and lets the human enter a value.

The input uses a password field with autocomplete disabled. JavaScript clears the field before awaiting the request and clears it again in `finally`.

The plaintext goes directly from the same-origin operator request to the existing `runtime.computer.supplySecret` path. It is not copied into:

- task state/events;
- memory;
- audit payloads;
- MCP tool results;
- the operator response body.

Downstream secret-driver errors are converted to the fixed public error `secret supply failed`.

## Passive status vs health

Opening or refreshing the console must not start a browser.

The dashboard therefore uses `computerLifecycle.status()`, which only inspects whether an already-managed driver object exists. It does not instantiate a driver or call `health()`.

The existing explicit computer `health()` endpoint retains its historical behavior and may start/connect the managed sidecar. Use **Start** or explicit health intentionally when you want active probing.

## Remaining v0.4 work

The first console is intentionally operational rather than a generic admin framework. Remaining v0.4 items include:

- richer live DAG visualization;
- policy editor + dry-run/explain view;
- stronger computer lease/health telemetry without active probes;
- installer/desktop launch experience;
- optional event streaming instead of manual refresh.
