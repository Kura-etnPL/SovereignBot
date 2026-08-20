# Security

SovereignBot is a local-first agent runtime. A configured worker may execute powerful tools, so the runtime treats **authority as a separate layer from intelligence**.

## Defaults

- The main HTTP server binds to `127.0.0.1` by default.
- Policy is fail-closed: no matching allow rule means deny.
- Deny rules run before allow rules.
- Runtime hard-safety denials cannot be overridden by a broad policy allow.
- Command, Codex, Claude Code, WebDriver, and sidecar processes are launched with `shell: false`.
- SovereignBot does not enable Codex sandbox bypass or a permissive Claude Code permission mode by default.
- Governed decisions are written to the hash-chained audit before side effects.
- Task, event, computer-state, and audit mutations are serialized where concurrent writers would corrupt or resurrect stale state.
- `.sovereignbot/`, `.env`, logs, bearer-token files, browser profiles, and local runtime state are ignored by Git.

## General server authentication boundary

The v0.3 **computer routes are bearer-token protected**, but the broader task-graph/control API is still a loopback-local operator surface and does not yet bind protocol actor ids such as `actorAgentId` to an authenticated user session.

Therefore:

- keep the main server on loopback unless it is behind a trusted authenticated local gateway;
- do not treat `actorAgentId` / `reviewerAgentId` strings as authentication credentials;
- do not expose the task graph API directly to an untrusted LAN/Internet client.

The computer API uses a stronger boundary described below.

## Supervisor / worker boundary

Supervisor role grants planning/delegation visibility, not implicit worker execution rights. Worker ownership is assigned only when a compatible worker is selected and its governed harness launch is allowed.

Independent review can prevent the executing worker from approving its own candidate result.

Progress/review event ids are idempotency keys, not secrets. Reusing an id for a different task/event type is rejected.

## Codex harness boundary

The Codex adapter launches the user's independently installed/signed-in Codex CLI and persists the emitted session id so work can resume.

Governance at the harness boundary controls **launch/resume**, not every internal Codex shell/MCP/browser/file/network action. Those internal tools remain subject to Codex configuration/sandbox unless the worker is explicitly wired to SovereignBot's governed tool/computer API.

Do not give a Codex worker raw WebDriver/CDP access as a shortcut around that integration. A governed bridge must call SovereignBot's computer API with the worker identity and current task.

## Claude Code harness boundary

The Claude Code adapter launches the independently installed official `claude` executable. SovereignBot does not embed Claude/Anthropic login, redistribute account credentials, or proxy third-party rate limits.

As with Codex, launch/resume governance does not automatically intercept every internal Bash/file/MCP/browser/plugin/subagent action. Those remain subject to Claude Code settings, permissions, hooks, plugins, MCP configuration, sandbox availability, and OS account rights unless integrated through a governed SovereignBot capability.

## Governed computer authority

Each worker receives a distinct computer identity with its own:

- random bearer token;
- browser profile;
- workspace;
- server-held snapshot/ref cache;
- production sidecar/browser process/session when enabled.

Agent ids are encoded with collision-free base64url keys for filesystem/state storage.

A production worker computer action requires **all three**:

1. the bearer token for that exact worker;
2. a task currently in `running` state and assigned to that worker;
3. an allowed Governor decision plus all hard runtime safety checks.

A leaked worker token cannot be paired with an invented task id or another worker's task.

The operator token is independent. Agent tokens are not accepted on operator routes and the operator token is not returned through HTTP.

Bootstrap tokens only with the local CLI and protect their output like credentials.

## Snapshot/ref boundary

Workers never supply a trusted WebDriver/backend handle.

The production sidecar converts WebDriver element ids to random private handles; the core then assigns a server-held snapshot/ref mapping. Workers receive only safe public element metadata.

Stale/missing snapshots and invented refs are refused before driver side effects. Browser reset/restart rotates the browser session lease, invalidating all prior handles.

## Browser egress boundary

The WebDriver sidecar forces browser HTTP(S) through a private loopback proxy. For each connection the proxy:

1. resolves destination DNS itself;
2. classifies every returned IP;
3. rejects blocked classes;
4. connects directly to the validated IP rather than resolving the hostname again.

Cloud metadata, link-local, multicast, benchmark/documentation/reserved address ranges remain blocked. Ordinary private/loopback/CGNAT/ULA networks are blocked by default and only opened by `computer.allowPrivateHosts: true`.

Chrome disables QUIC and non-proxied WebRTC UDP; Firefox disables peer connection in the sidecar profile.

### Egress limitation

The proxy is **not equivalent to a kernel network namespace/firewall**. It materially improves the hostname→connect boundary and reduces DNS-rebinding TOCTOU, but higher-risk hostile-browser deployments should place the same sidecar contract inside a container/VM/firewall boundary for defense in depth.

SovereignBot does not claim that user-space proxy enforcement alone prevents every possible browser/network escape or browser vulnerability.

## WebDriver transport boundary

The bundled sidecar binds only to loopback and uses a fresh random core↔sidecar transport token that is distinct from worker/operator bearer tokens.

Configured external WebDriver endpoints are accepted only as loopback HTTP endpoints. Raw remote WebDriver is intentionally rejected; a future remote/VM deployment should use an authenticated transport rather than exposing WebDriver over the network.

Side-effecting browser operations are never automatically retried after transport loss because the action may have reached the browser even if its response was lost.

## Workspace boundary

Each worker has a distinct workspace. File paths must be relative and remain inside it. Absolute paths, traversal, NUL paths, and symlink/junction escapes are refused.

File contents are not put into the computer policy/audit metadata path.

## Human takeover

A help request pauses agent computer actions. Operator takeover persists durable control state, and while human control is active agent actions fail closed rather than queueing.

Operator start/stop/reset lifecycle actions are audited.

## Secret channel

A secret request stores only request metadata (id/task/label/snapshot/ref/time). Plaintext supplied by the operator is handed directly to the dedicated `typeSecret` execution path.

Defense in depth:

- normal computer audit/policy metadata never receives type/write plaintext;
- the public secret-supply API replaces downstream errors with a fixed message;
- secret-operation audit errors are replaced with a fixed message;
- credential-shaped audit keys (password/secret/token/auth/cookie/API key/session id) are redacted before hashing/persistence.

No component can guarantee that a compromised browser itself will not send a credential to the page it is intentionally typing into; that is the purpose of the action. The guarantee is about not copying that plaintext into SovereignBot's ordinary state/audit/error channels.

## Browser profile isolation scope

v0.3 uses separate processes/sessions/profiles/workspaces per worker. It does not claim VM-strength OS isolation between browser processes running as the same account.

For high-risk accounts or untrusted sites, run the sidecar under a dedicated OS account/container/VM. The driver-neutral contract is designed to support that without weakening or rewriting the Governor.

## Third-party account terms

Users/downstream distributors are responsible for complying with the current terms of model/agent/browser products they connect. SovereignBot's adapters control locally installed tools; they are not intended to resell or redistribute third-party authentication or usage entitlements.

## Reporting a vulnerability

Please open a GitHub security advisory when available. Avoid public issues containing working exploit details, bearer tokens, account credentials, session material, or other secrets.
