# Security

SovereignBot is a local-first agent runtime. A configured harness may be able to execute powerful tools, so the runtime treats **authority as a separate layer from intelligence**.

## Defaults

- The HTTP API binds to `127.0.0.1` by default.
- Policy is fail-closed: no matching allow rule means deny.
- Command and Codex harness processes use `spawn(..., { shell: false })`.
- SovereignBot does not enable Codex approval/sandbox bypass flags.
- Every governed action decision is written to a tamper-evident hash-chained audit log before execution.
- `.sovereignbot/`, `.env`, logs, and local runtime state are ignored by Git.

## Codex harness boundary

The v0.2 Codex adapter reuses the locally installed Codex CLI and its existing authentication/configuration. SovereignBot persists the Codex session id so a failed task can resume the same session, but the audit log records only that harness state changed, not the session id itself.

**v0.2 governance applies to launching/resuming the Codex harness. It does not yet intercept each shell, MCP, browser, file, network, or computer action performed inside Codex.** Those internal actions remain subject to the user's Codex configuration and sandbox. Fine-grained action interception belongs to the governed-computer milestone.

Treat a Codex worker's working directory, Codex permissions, configured MCP servers, and inherited environment as part of the worker's effective trust boundary.

## Operator responsibilities

Do not expose the v0.2 HTTP API directly to an untrusted network. It has no authentication yet. If you bind to a non-loopback interface, put an authenticated reverse proxy in front of it.

Treat any command or Codex harness configuration as code execution. Only configure executables and arguments you trust. Use a dedicated OS account, container, VM, or sandbox for higher-risk workers.

Avoid placing secrets directly into task text unless the selected worker is intended to receive them. A dedicated secret-entry channel that stays outside task transcripts is planned for the governed-computer layer.

## Reporting a vulnerability

Please open a GitHub security advisory when available. Avoid filing public issues that contain working exploit details or secrets.
