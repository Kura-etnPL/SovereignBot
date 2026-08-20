# Governed MCP bridge for Codex and Claude Code

SovereignBot can attach its governed computer capability directly to a Codex or Claude Code worker through a task-scoped local **stdio MCP server**.

The bridge exists to preserve one rule: the model receives a useful tool, not raw browser authority.

```text
Codex / Claude Code
       |
       | stdio MCP
       v
SovereignBot governed MCP server
       |
       | random task-scoped capability
       v
loopback broker
       |
       | fixed agentId + taskId (server-side only)
       v
TaskBoundComputerGateway
       |
       v
Governor + hard safety + audit
       |
       v
WebDriver sidecar / workspace
```

The bridge does not expose WebDriver ids, CDP, Playwright, browser-debug ports, computer bearer tokens, operator tokens, agent ids, or caller-selectable task ids.

## Enable it

Add `governedTools` to a Codex or Claude Code worker:

```json
{
  "id": "codex-browser-worker",
  "name": "Codex Browser Worker",
  "role": "worker",
  "capabilities": ["coding", "browser"],
  "governedTools": ["computer"],
  "harness": {
    "kind": "codex",
    "cwd": "."
  }
}
```

or:

```json
{
  "id": "claude-browser-worker",
  "name": "Claude Browser Worker",
  "role": "worker",
  "capabilities": ["coding", "browser"],
  "governedTools": ["computer"],
  "harness": {
    "kind": "claude-code",
    "cwd": "."
  }
}
```

`governedTools` is accepted only on the first-party Codex and Claude Code harnesses. It is not a generic command-harness escape hatch.

## Tool surface

The worker receives:

- `snapshot`
- `navigate`
- `click`
- `type`
- `key`
- `scroll`
- `list_files`
- `read_file`
- `write_file`
- `request_help`
- `request_secret`

There is deliberately **no `supply_secret` tool**.

`type` is for ordinary text the model already knows. Operator-provided passwords, OTPs, recovery codes, card data, or other secrets should use `request_secret`; the operator supplies the value through the separate operator channel and the model/MCP process never receives that plaintext.

## Task-scoped capability

The provider never receives the normal worker computer bearer token.

When a task enters `running` under a governed worker, SovereignBot creates a random 256-bit bridge capability and stores its immutable mapping to:

```text
agentId = assigned worker
taskId  = current running task
```

Neither identity is a tool argument. A caller cannot ask the bridge to operate another task.

Every broker invocation still goes through `TaskBoundComputerGateway`, which re-reads durable task state. If the task is cancelled, completed, blocked, or reassigned, subsequent tool calls fail closed even if an old MCP process is still alive.

## One-shot bootstrap

The MCP process must learn the private broker capability without putting it in model text or provider CLI flags.

SovereignBot writes a mode-0600 one-shot bootstrap file containing only:

- loopback broker URL;
- random bridge capability;
- protocol marker.

Provider configuration contains **the bootstrap file path**, not the capability.

The MCP server reads the file once and immediately deletes it. Harness completion, timeout, cancellation, or bridge shutdown revokes the server-side capability and removes any remaining bootstrap/config files.

A crashed MCP process therefore does not silently restart with stale authority. The provider task can fail/retry and receive a fresh bridge.

### Same-user process boundary

Mode-0600 + one-shot deletion protects against ordinary accidental disclosure, but processes running as the same OS account are not a VM/security boundary. A hostile same-user shell process may race local files or inspect processes using OS-specific mechanisms.

For higher-risk workers, run the worker/sidecar under a dedicated OS account, container, or VM. The bridge does not weaken the existing computer policy if a capability is obtained: the capability remains limited to the same worker/task and every action still goes through the Governor.

## Codex attachment

For Codex, SovereignBot adds task-local `--config` overrides for one MCP server named `sovereignbot`:

```text
mcp_servers.sovereignbot.command
mcp_servers.sovereignbot.args
mcp_servers.sovereignbot.required=true
...
```

The server command is local Node plus the one-shot bootstrap path. No OpenAI API key or ChatGPT credential is injected.

The MCP server's own approval mode can be pre-approved because approval is **not the authority layer** here; all side effects still pass through SovereignBot's hard-safety checks and Governor.

Codex's existing resumable session id remains unchanged.

## Claude Code attachment

For Claude Code, SovereignBot creates a temporary local `--mcp-config` JSON file containing the same stdio MCP command, then adds only the `mcp__sovereignbot__...` tools to Claude's allowed-tool set.

The config file contains no bridge capability; it contains only the MCP command and bootstrap path. It is deleted when the harness finishes.

Claude Code's existing authentication/session remains independent from SovereignBot.

## Existing provider tools

This bridge does not claim that it can erase every external tool the operator has separately configured in Codex or Claude Code. Operators should not give the same governed worker a second raw browser MCP/CDP/Playwright path that bypasses SovereignBot.

Where a provider has a first-party browser integration, prefer disabling it for a worker intended to use the governed browser path. A future hardened worker profile can make provider tool isolation stricter without changing the MCP authority contract.

## Auditing

Bridge lifecycle rows include:

- bridge opened;
- tool call name;
- bridge closed/revoked.

Tool arguments are not copied into bridge-level audit rows. The actual computer/file action produces its normal Governor/security audit entry.

This avoids duplicating typed text/file contents into orchestration logs.

## Real-browser acceptance test

CI runs a real Chrome chain with a fake provider task:

```text
stdio MCP
  -> task-scoped broker
  -> TaskBoundComputerGateway
  -> Governor
  -> WebDriver sidecar
  -> Chrome
```

The test navigates to a local login fixture, snapshots structured fields, types a username through MCP, requests a password, supplies that password through the operator path outside MCP, clicks Sign in, verifies the resulting page state, then revokes the bridge and proves subsequent MCP calls fail.
