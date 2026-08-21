# Roadmap

## v0.1 — sovereign core

- [x] Durable local task state
- [x] Durable scoped memory
- [x] Capability-based multi-agent scheduling
- [x] Explicit fail-closed policy engine
- [x] Repeat-action guard primitives
- [x] Tamper-evident audit log
- [x] Generic local command harness
- [x] Loopback HTTP control API
- [x] CLI and CI

## v0.2 — real agent harnesses and coordination

- [x] Codex CLI adapter with resumable task sessions
- [x] Claude Code CLI adapter with resumable task sessions
- [x] Retry transition that preserves captured harness session state
- [x] Supervisor/worker task graph and delegation protocol
- [x] Durable task-event history and structured progress snapshots
- [x] Dependency-aware scheduling and cascading cancellation
- [x] Independent reviewer/approval + changes-requested retry flow
- [x] Adapter-driven Claude Code progress/retry events

## v0.3 — governed computer layer

- [x] Per-agent computer identity, browser profile, workspace, bearer token, and process/session boundary
- [x] Server-held snapshot/ref model with private driver handles and stale-ref refusal
- [x] Production W3C WebDriver sidecar for Chrome/Edge/Firefox
- [x] Real Chrome + ChromeDriver E2E in CI
- [x] Running-task ownership binding in front of computer actions
- [x] Token-protected worker/operator computer API
- [x] Human take-over and hand-back
- [x] Secret-entry channel excluded from task/memory/audit payloads
- [x] Filesystem and browser/network policy context
- [x] Connection-time resolved-address egress proxy with hard metadata/reserved blocks
- [x] Sidecar health, process/browser leases, start/stop/reset lifecycle
- [x] Cross-platform core tests on Ubuntu/Windows Node 22/24
- [x] Governed MCP/computer tool bridge for Codex/Claude Code workers
- [x] Persistent repeat detection across runtime/process restarts
- [ ] Optional container/VM/kernel egress isolation profile for higher-risk workers

## v0.4 — operator experience

- [x] Secure loopback local web UI + short-lived operator sessions
- [ ] Live/streaming task graph and richer worker/computer telemetry
- [x] Policy draft editor + side-effect-free validate/dry-run explain
- [ ] Transactional/versioned policy apply + rollback
- [x] Human takeover/secret prompt surface
- [x] Memory inspector/search
- [x] Audit timeline + integrity badge
- [ ] One-command Windows/macOS/Linux installer

## Later integrations

- [ ] AG-UI adapter where it improves interoperability
- [ ] Generic governed MCP client/bridge
- [ ] Harness health/lease telemetry beyond computer workers

## Non-goals

- Mandatory metered model APIs
- Mandatory hosted memory/thread backends
- A single model/provider as the product architecture
- Weakening governance to make integrations easier
- Falling back to coordinate-only visual control when a structured driver is unavailable
