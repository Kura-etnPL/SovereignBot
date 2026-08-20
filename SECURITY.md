# Security

SovereignBot is a local-first agent runtime. A configured harness may be able to execute powerful tools, so the runtime treats **authority as a separate layer from intelligence**.

## Defaults

- The HTTP API binds to `127.0.0.1` by default.
- Policy is fail-closed: no matching allow rule means deny.
- Command harnesses use `spawn(..., { shell: false })`.
- Every governed action decision is written to a tamper-evident hash-chained audit log before execution.
- `.sovereignbot/`, `.env`, logs, and local runtime state are ignored by Git.

## Operator responsibilities

Do not expose the v0.1 HTTP API directly to an untrusted network. It has no authentication yet. If you bind to a non-loopback interface, put an authenticated reverse proxy in front of it.

Treat any command harness configuration as code execution. Only configure executables and arguments you trust. Use a dedicated OS account, container, VM, or sandbox for higher-risk workers.

## Reporting a vulnerability

Please open a GitHub security advisory when available. Avoid filing public issues that contain working exploit details or secrets.
