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

## v0.2 — real agent harnesses

- [ ] Codex CLI adapter with resumable task sessions
- [ ] Claude Code adapter with resumable task sessions
- [ ] AG-UI adapter
- [ ] MCP client adapter
- [ ] Harness health, leases, cancellation, and structured progress events
- [ ] Supervisor/worker plan contract and delegation protocol

## v0.3 — governed computer layer

- [ ] Per-agent browser/computer isolation
- [ ] Snapshot/ref based browser actions
- [ ] Human take-over and hand-back
- [ ] Secret-entry channel excluded from transcripts
- [ ] Filesystem/network/MCP policy contexts
- [ ] Persistent distributed repeat detection

## v0.4 — operator experience

- [ ] Local web UI
- [ ] Live task graph and worker status
- [ ] Policy editor + dry run
- [ ] Memory inspector
- [ ] Audit timeline + integrity badge
- [ ] One-command Windows/macOS/Linux installer

## Non-goals

- Mandatory metered model APIs
- Mandatory hosted memory/thread backends
- A single model/provider as the product architecture
- Weakening governance to make integrations easier
