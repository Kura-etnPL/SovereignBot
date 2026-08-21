# Persistent repeat / runaway-loop safety

SovereignBot's production `Governor` persists repeat-attempt state so restarting the runtime does not reset a runaway worker's safety counter.

## What is persisted

The state file is:

```text
<dataDir>/repeat-state.json
```

Each active repeat identity is represented only by:

- a deterministic SHA-256 fingerprint;
- timestamps inside the active repeat window.

The fingerprint is computed from the same identity used by the historical in-memory counter:

```text
agentId + category + operation + (repeatKey or target) + taskId
```

The raw components are **not** written to the repeat-state file. In particular the store does not persist:

- target URLs or query strings;
- typed text;
- file contents;
- passwords, OTPs, recovery codes, or other secret values;
- provider credentials;
- worker/operator bearer tokens.

## Fail-closed ordering

For production governed actions the order is:

```text
action attempt
  -> serialize repeat observation
  -> prune expired timestamps
  -> add current attempt
  -> atomically persist repeat-state.json
  -> evaluate PolicyEngine with the persisted repeatCount
  -> audit allow/deny
  -> side effect only if allowed
```

If repeat-state persistence fails, Governor denies the action. SovereignBot never silently falls back to an empty in-memory counter in the production runtime.

The current attempt counts before `repeatAtLeast` is evaluated, preserving the original threshold semantics.

## Concurrency and capacity

Observations inside one runtime process are serialized. Concurrent identical attempts therefore receive monotonic counts instead of racing read/modify/write operations.

`policy.repeatMaxActiveFingerprints` limits the number of simultaneously active fingerprints (default `10000`). If a new active fingerprint would exceed the limit, the action fails closed. Active safety state is not evicted merely to make room.

Expired timestamps are pruned using `policy.repeatWindowMs` (default `180000` ms).

## Restart behavior

A new SovereignBot runtime using the same `dataDir` loads the existing active repeat state. Attempts still inside the configured window continue from the persisted count.

## One authoritative runtime per dataDir

`repeat-state.json` uses atomic file replacement and in-process serialization. It is **not** a distributed multi-writer database or cross-process lock service.

Run one authoritative SovereignBot runtime process per `dataDir`. If multiple independent runtimes need to operate concurrently, give them separate data directories until a true shared transactional state backend is intentionally designed.

This restriction prevents two processes from each reading the same old state and overwriting the other's repeat observation.

## Library compatibility

`PolicyEngine.decide(action)` remains synchronous and retains its original in-memory repeat tracker for direct/library usage and unit tests.

The production `Governor` supplies the durable `repeatCount` after persistence. This keeps the public policy API compatible while making the actual runtime restart-safe.
