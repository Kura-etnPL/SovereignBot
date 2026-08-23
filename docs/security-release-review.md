# SovereignBot v1.0 security release review

This document records the security boundary reviewed immediately before the v1.0 release candidate. It supplements `SECURITY.md`; it is not a claim that a same-user local process is a VM or hardware security boundary.

## Authority classes

SovereignBot intentionally distinguishes credentials, capabilities, continuity metadata, ordinary product data, and browser-login state.

| Class | Examples | Durable? | Ordinary UI / CLI / telemetry? |
| --- | --- | --- | --- |
| Provider authentication | Codex/Claude login material owned by the independently installed provider CLI; credential-shaped configured environment values | Provider/config owned, not copied by SovereignBot into ordinary state | No |
| Provider continuity metadata | Codex thread/session id; Claude Code session id used to resume a task | Yes, internally in `task.harnessState` | No raw value. Public task views expose only `hasResumableSession`. |
| Worker computer authority | Per-worker random computer bearer token | Yes, under sensitive computer state | Only the explicit local `computer token <agent-id>` bootstrap command returns it. Never generic task/UI/telemetry output. |
| Durable operator computer authority | Independent computer operator token | Yes | Only the explicit local `computer operator-token` bootstrap command returns it. The HTTP API does not return it. |
| Operator-console authority | Short-lived local operator-session bearer | Hash-only session record plus expiry | Issued once by the explicit local `operator-session` command; never returned by normal Operator endpoints/telemetry. |
| Governed bridge authority | Per-running-task bridge capability and local bootstrap material | Ephemeral | Never ordinary output; revoked before bridge cleanup and excluded from backup/export. |
| Secret-supply plaintext | Password/secret typed by the operator into an explicit pending browser request | No ordinary durable copy | Never returned to the model/worker, task result, memory, event, telemetry, or audit plaintext path. |
| Browser login/profile material | Cookies, browser profile databases, logged-in sessions | Durable only in the per-worker profile | Never normal export/release output. Included only by explicitly sensitive full-computer backup. |

## Findings and v1 fixes

The pre-release review found four public-boundary problems rather than treating the security gate as a paperwork exercise:

1. Operator task overview/graph returned the complete internal task object, including `harnessState.sessionId`.
2. Codex/Claude success output structurally included `sessionId`, so Orchestrator persisted a duplicate into task result and task-result memory.
3. Ordinary local CLI task/status/graph output also printed the complete internal task object.
4. The older loopback task API returned complete agent/task/memory/event objects. `/agents` could therefore expose full harness configuration/environment, and task submission could carry runtime-owned fields such as `harnessState`, assigned/owner identity, result/error/progress, or retry attempt state.

The v1 boundary keeps capability and observability without those leaks:

- provider parsers may still discover a provider session/thread id;
- `updateHarnessState()` persists the reference in internal `task.harnessState` so retry/restart can resume;
- the common provider-result boundary removes the system-added top-level `sessionId` before a successful result becomes task result/candidate memory;
- provider failure text has an exact known continuity reference replaced before it becomes task error;
- common public task projection omits `harnessState` and exposes only `hasResumableSession`;
- Operator, ordinary CLI, and loopback task/memory/event responses use the same continuity projection;
- `/agents` exposes safe agent metadata rather than the full harness object/environment;
- HTTP task creation/delegation strips runtime-owned task fields before calling Orchestrator, so a client cannot seed a provider resume reference or pre-completed internal state through the ordinary task submission surface;
- worker telemetry reports only resumable task counts, not provider ids;
- audit credential-shaped `sessionId` fields are redacted before persistence.

SovereignBot does **not** rewrite arbitrary model final text merely because the model happens to mention a string. The boundary removes infrastructure-added structured continuity fields and exact continuity references in system error metadata, not user/model content in general.

### Pre-v1 development state

Some pre-v1 development state may already contain the former duplicate `result.sessionId`, candidate-result memory, aggregate child result, or provider failure error while the authoritative resume reference also exists in `harnessState.sessionId`.

v1 does not invent a generic state migration or rewrite the hash-chained audit to hide that historical data. Instead, public compatibility projection is narrow and deterministic:

- the set of sensitive continuity values is derived only from tasks whose internal harness kind is `codex` or `claude-code`;
- a structured `sessionId` is removed only when its value exactly equals one of those known internal continuity refs;
- an `error` string has only exact known refs replaced;
- task-result/candidate-result memory is projected, while unrelated arbitrary memory is not rewritten;
- audit/event files remain unchanged at rest, preserving their integrity/history, while their Operator/CLI/task-API views redact known continuity refs;
- an unrelated business/command result whose `sessionId` is not a known provider continuity ref remains visible.

Recovery backups remain recovery backups: internal `harnessState` continuity metadata is retained because deleting it would break retry/resume. Protect durable state and backups as local sensitive state.

## Governed computer and MCP authority

The release review preserves the existing authority chain:

`worker bearer -> exact running task -> exact assigned/owning worker -> Governor decision -> hard runtime safety -> computer side effect`

A worker token is insufficient on its own. The task-bound gateway rejects missing/invented tasks, non-running tasks, tasks owned by another worker, and actions after terminal completion/cancellation. The HTTP computer API authenticates the worker and then delegates to the same task-bound gateway.

The governed MCP bridge binds its capability server-side to the task and worker chosen by SovereignBot. The worker does not choose `agentId`/`taskId` in tool calls. Closing/aborting the bridge revokes the capability before cleanup/audit best effort, so stale bootstrap material cannot resurrect authority.

## Secret supply

Workers may request a secret against a fresh server-held browser snapshot/ref. They cannot supply it.

- governed MCP exposes `request_secret` and no `supply_secret` tool;
- worker computer bearer authority is rejected on the operator secret-supply route;
- a valid short-lived same-origin Operator session may satisfy a valid pending request;
- plaintext goes directly to the dedicated `typeSecret` path;
- public errors are fixed/redacted, and plaintext is not copied into task/event/memory/audit/telemetry state.

The page receiving the typing can of course receive the secret. That is the intended browser side effect, not a claim that the destination website cannot observe its own form input.

## Browser/network hard safety

Editable policy is not the outermost safety boundary. Hard URL and egress checks execute independently of broad allow rules.

- credential-bearing URLs and unsupported schemes are rejected;
- cloud metadata and other always-blocked address classes remain denied even when `computer.allowPrivateHosts` is enabled;
- private/loopback access is controlled by the explicit computer setting, not by an editable policy allow rule;
- browser proxy DNS resolution/classification is fail-closed for unsafe addresses;
- URL query/fragment material is not copied verbatim into audit metadata;
- live policy activation cannot turn a hard-denied target into an allowed one.

The user-space proxy is defense in depth, not a kernel network namespace. High-risk browser workers should still run under a dedicated OS account/container/VM/firewall boundary as documented in `SECURITY.md`.

## Release/publication surface

The public v1 release workflow is separated from local runtime state:

- build input comes from the reviewed repository checkout, not `.sovereignbot/`, local config, browser profiles, or backup directories;
- default workflow permission is `contents: read`;
- verification adds only `pull-requests: read` for merged-PR provenance;
- only the downstream publish job receives `contents: write`;
- stable publication is chained from successful `CI` on `main`, checks the exact CI SHA against current `main`, requires merged-PR provenance, and requires reviewed versioned release notes;
- artifacts are built/verified before the privileged publish job and are downloaded rather than rebuilt there;
- existing tags/releases are not silently moved or overwritten.

## Executable evidence

The final frozen release-review PR must keep the complete seven-job matrix green. Focused evidence includes:

- `tests/security-release-review.test.js` — provider result/memory/audit canaries, Operator authority surfaces, operator-only secret supply, and hard-network/policy precedence;
- `tests/security-legacy-continuity.test.js` — historical provider continuity duplicates remain at rest but are redacted from Operator/CLI views without blanket-removing unrelated business `sessionId` fields;
- `tests/security-loopback-api.test.js` — legacy loopback `/agents`/task/memory/event reads use safe projections, provider/config canaries do not escape, and HTTP submission cannot persist forged runtime-owned task state;
- `tests/task-bound-computer.test.js` — exact running-task ownership and cross-worker/invented/terminal task refusal;
- `tests/computer-gateway.test.js` — hard URL/navigation guards, private-host setting, audit URL redaction, and secret channel behavior;
- `tests/sidecar-driver.test.js` — secret-error redaction, browser lease freshness, and egress address classification;
- governed MCP tests — task-bound bridge authority and cleanup/revocation;
- operator/worker telemetry tests — short-lived session authentication and absence of provider task payload/session ids;
- release workflow tests — least-privilege permissions, successful-main-CI provenance, immutable tag/release behavior, and deterministic artifact handoff.

The PR description records the exact frozen head SHA and CI run once the final matrix is complete.

## Residual local-isolation limits

SovereignBot is local-first. A process running as the same OS account with permission to read the data directory can read internal durable state, including provider continuity references and (in the sensitive computer tree) bearer tokens/browser profiles. Public projection is not an OS sandbox.

For higher-risk workers/accounts, combine SovereignBot's authority model with OS-account separation, a container/VM, and network controls. This does not weaken the supported local core path; it states the boundary accurately.
