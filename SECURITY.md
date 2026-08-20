# Security

SovereignBot is a local-first agent runtime. A configured harness may be able to execute powerful tools, so the runtime treats **authority as a separate layer from intelligence**.

## Defaults

- The HTTP API binds to `127.0.0.1` by default.
- Policy is fail-closed: no matching allow rule means deny.
- Command, Codex, and Claude Code harness processes use `spawn(..., { shell: false })`.
- SovereignBot does not enable Codex approval/sandbox bypass flags or a permissive Claude Code permission mode by default.
- Every governed action decision is written to a tamper-evident hash-chained audit log before execution.
- Task-state mutations, task-event appends, and audit-chain appends are serialized to avoid stale/concurrent writers corrupting durable state.
- `.sovereignbot/`, `.env`, logs, and local runtime state are ignored by Git.

## Supervisor / worker boundary

A supervisor plan may delegate and inspect work, but supervisor role does not make that agent eligible to execute normal worker tasks. Worker ownership is assigned only after a compatible worker is selected and the governed harness launch is allowed.

Review can require a separate reviewer capability and can forbid the executing worker from approving its own candidate result.

The task-graph API currently accepts agent ids such as `actorAgentId` and `reviewerAgentId` as local protocol identities. **Those fields are not authentication credentials.** v0.2 has no network authentication layer, so an untrusted caller that can reach the local API must be assumed able to impersonate those protocol identities. Keep the API on loopback until authenticated actor/session binding is implemented, or put a trusted authenticated proxy in front of it.

Progress/review event ids are idempotency keys, not secrets. Reusing one id for a different task/event type is rejected.

## Codex harness boundary

The v0.2 Codex adapter reuses the locally installed Codex CLI and its existing authentication/configuration. SovereignBot persists the Codex session id so a failed task can resume the same session, but the audit log records only that harness state changed, not the session id itself.

**v0.2 governance applies to launching/resuming the Codex harness. It does not yet intercept each shell, MCP, browser, file, network, or computer action performed inside Codex.** Those internal actions remain subject to the user's Codex configuration and sandbox. Fine-grained action interception belongs to the governed-computer milestone.

Treat a Codex worker's working directory, Codex permissions, configured MCP servers, and inherited environment as part of the worker's effective trust boundary.

## Claude Code harness boundary

The Claude Code adapter launches the operator's independently installed official `claude` binary. SovereignBot does not embed a Claude/Anthropic sign-in flow, distribute account credentials, or copy Claude Code session credentials into its configuration.

SovereignBot persists the Claude Code session id emitted by the stream so failed work can resume the same session. The audit trail records only the fact that harness state changed, not the session id itself.

**v0.2 governance applies to launching/resuming the Claude Code harness, not to each internal Bash, file, MCP, Chrome, network, plugin, hook, or subagent action.** Those remain subject to Claude Code's own settings, permission mode, sandbox availability, hooks, plugins, MCP configuration, and OS account permissions.

The example configuration does not set `bypassPermissions` or another broad permission override. If an operator explicitly configures a permissive Claude Code mode, that choice expands the worker's effective trust boundary.

## Operator responsibilities

Do not expose the v0.2 HTTP API directly to an untrusted network. It has no authentication yet. If you bind to a non-loopback interface, put an authenticated reverse proxy in front of it.

Treat any command, Codex, or Claude Code harness configuration as code execution. Only configure executables and arguments you trust. Use a dedicated OS account, container, VM, or sandbox for higher-risk workers.

Avoid placing secrets directly into task text unless the selected worker is intended to receive them. A dedicated secret-entry channel that stays outside task transcripts is planned for the governed-computer layer.

Users and downstream distributors are responsible for complying with the current terms of the model/agent products they connect. SovereignBot's adapter model is intended to control a user's locally installed tools, not to resell, proxy, or redistribute third-party authentication or rate limits.

## Reporting a vulnerability

Please open a GitHub security advisory when available. Avoid filing public issues that contain working exploit details or secrets.
