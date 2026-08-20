# Architecture

SovereignBot is built around a small rule: **reasoning systems are replaceable; authority is not**.
A worker can be Codex, Claude Code, a local process, an AG-UI service, or something that does not exist yet. The runtime owns identity, task state, policy, memory, and the audit trail.

```text
                 +---------------------------+
                 |        User / API         |
                 +-------------+-------------+
                               |
                               v
                 +---------------------------+
                 |       Orchestrator        |
                 | queue / route / delegate  |
                 +------+------+-------------+
                        |      |
              memory <--+      +--> task store
                        |
                        v
                 +---------------------------+
                 |         Governor          |
                 | deny -> allow -> deny     |
                 +-------------+-------------+
                               |
                         audit decision
                               |
                               v
                 +---------------------------+
                 |      Harness Adapter      |
                 | echo / command / future   |
                 +-------------+-------------+
                               |
                               v
                 +---------------------------+
                 | Local/subscription agent  |
                 | or another owned runtime  |
                 +---------------------------+
```

## Core invariants

### 1. Fail closed

An action runs only if an explicit allow rule matches. Deny rules are evaluated first. If policy evaluation throws, the governor denies the action and records why.

### 2. Audit before action

The governor writes the allow/deny decision before the orchestrator launches a harness. The audit file is append-only JSONL with a SHA-256 hash chain, so later modification is detectable with `sovereignbot audit verify`.

### 3. Durable state is local

Tasks and memory live under `dataDir`. No cloud thread or memory service is required. The current store is intentionally simple and inspectable; a SQLite event store is planned behind the same interfaces.

### 4. Harnesses are adapters, not the runtime

A command harness is launched with `shell: false` and receives one JSON request on stdin. It may wrap a local model, a subscription CLI, a remote agent client, or a custom executor. The runtime does not need provider API keys to exist.

### 5. Capability-based scheduling

Tasks declare required capabilities. The scheduler considers only agents that satisfy all of them, respects per-agent concurrency, then chooses the least-busy highest-priority candidate.

## Why this differs from OpenBot

OpenBot has an excellent governed-computer boundary and per-Bot computer isolation. SovereignBot keeps the governance idea but moves durable history and memory into the local runtime, makes the agent connection a generic harness boundary instead of one required protocol, and does not require a commercial control-plane service to boot.

The projects are complementary: OpenBot is a strong reference for governed browser computers; SovereignBot focuses first on sovereignty of orchestration, state, and agent access.
