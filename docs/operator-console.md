# Local operator console

SovereignBot v0.4 includes a dependency-free local operator console for inspecting the runtime and performing explicit operator-only actions.

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

## Console surfaces

The console can show and manage:

- overview and task state;
- supervisor/worker task graphs and durable events;
- passive worker/harness utilization and in-flight execution;
- passive computer lifecycle/control state;
- pending human secret requests;
- local memory search;
- audit-chain integrity and recent audit rows;
- policy draft validation/dry-run;
- active policy version/hash and immutable history;
- explicit versioned policy Apply/Rollback.

## Operator actions

Deliberate operator-only actions include:

- take human control;
- release control back to the agent;
- start/stop/reset a managed computer;
- supply a pending requested secret;
- activate a checked policy draft as a new immutable version;
- roll back to a verified historical policy version.

The UI does not expose raw WebDriver/CDP/Playwright handles, browser debug ports, worker bearer tokens, the durable computer operator token, or provider session identifiers.

## Session boundary

The durable computer operator credential remains inside runtime state. The browser receives only a separate short-lived operator-console capability.

SovereignBot stores each active console session as one file under:

```text
<dataDir>/operator-sessions/<sha256(token)>.json
```

The raw token is not stored. Session files contain only version/timestamps/label metadata. Per-session files also avoid a shared read-modify-write race when a running server revokes one session while a separate local CLI process creates another.

The same short-lived operator session is the only browser credential accepted by `/operator/policy/apply` and `/operator/policy/rollback`. Worker/computer bearer tokens and governed MCP capabilities do not authenticate to `/operator/*`.

## Loopback only

The built-in console and `/operator/*` API are enabled only when SovereignBot itself is configured on loopback (`127.0.0.1`, `localhost`, or `::1`) and the request arrives from loopback.

Binding the main server to a LAN/public interface does **not** automatically publish the operator console. Remote/public control is intentionally a separate post-v1.0 deployment problem with its own transport and threat model.

## Cross-origin protection

Operator mutations validate browser `Origin` when present and reject a mismatched origin. The page also uses a restrictive Content Security Policy:

- scripts/styles/connect: same origin only;
- no default external content;
- no embedding in frames;
- no external form target/base URI.

The short-lived bearer is sent in the `Authorization` header, not a cookie or query string.

## Live telemetry

The console opens an authenticated NDJSON stream with the short-lived operator session in the `Authorization` header.

The stream emits minimal invalidation signals for task/audit/harness activity; it does not send raw task payloads, model context, provider session ids, browser snapshots, secret values, or operator tokens.

Open streams re-check the session and terminate after revoke/expiry.

The Policy page is intentionally excluded from automatic telemetry rerender so background activity cannot overwrite or disrupt an in-progress draft.

## Policy workflow

The Policy page separates simulation from authority:

1. edit the policy draft in browser memory;
2. optionally validate it;
3. define a simulated action and repeat count;
4. run dry-run/explain;
5. **Apply checked policy** becomes available only for that current draft/action result;
6. Apply asks for explicit confirmation;
7. the server independently re-runs the expected dry-run check;
8. successful activation creates an immutable version, atomically moves the active pointer, swaps future Governor decisions, and records an audit commit;
9. history can be inspected and a verified prior version can be explicitly rolled back.

Editing draft/action/repeatCount invalidates the prior browser dry-run and disables Apply.

`repeatWindowMs` and `repeatMaxActiveFingerprints` are restart/migration-level persistent safety settings and cannot be changed by live Apply/Rollback.

See [policy-dry-run.md](policy-dry-run.md) and [policy-activation.md](policy-activation.md).

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

Opening or refreshing the console must not start a browser or provider CLI.

The computer dashboard therefore uses `computerLifecycle.status()`, which only inspects whether an already-managed driver object exists. It does not instantiate a driver or call `health()`.

Worker telemetry reads existing in-process/task state and does not launch Codex, Claude Code, MCP, or provider probes.

The existing explicit computer `health()` endpoint retains its historical behavior and may start/connect the managed sidecar. Use **Start** or explicit health intentionally when you want active probing.

## Recovery state

If a policy activation committed its audit record but the transaction marker could not be removed, the Policy page reports **RECOVERY REQUIRED**. The active committed policy remains in force, but further policy mutation is locked until restart/reconciliation.

If an activation is interrupted before a valid audit commit and rollback cannot be proven, startup fails closed rather than guessing which policy should be active.
