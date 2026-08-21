# Live operator telemetry

SovereignBot's local operator console can maintain a short-lived authenticated telemetry stream so task/computer/audit changes appear without high-frequency full-page polling.

## Transport

The stream is:

```text
GET /operator/stream
Authorization: Bearer <short-lived operator session>
```

The response is newline-delimited JSON (`application/x-ndjson`).

The console uses `fetch()` rather than `EventSource` so the bearer token remains in an Authorization header. The token is never placed in a query string, URL, cookie, localStorage, or sessionStorage.

## Authority boundary

The stream is available only when:

- SovereignBot is bound to loopback;
- the request originates from loopback;
- the short-lived operator session is valid;
- an optional browser `Origin` header matches the current SovereignBot origin.

Opening the stream grants **visibility only**. It does not create a second computer/task authority path and cannot execute actions.

## Session lifetime

Authentication is not checked only once.

While the connection remains open, SovereignBot periodically re-validates the short-lived operator session. If the session expires, is revoked, or session state becomes unreadable, the stream fails closed and ends.

A previously opened connection therefore cannot outlive its operator session indefinitely.

## Notification shape

The stream deliberately carries small invalidation signals, not full records.

Task notification:

```json
{
  "streamSeq": 12,
  "source": "task",
  "type": "task.progress",
  "taskId": "task_...",
  "sourceSeq": 4,
  "at": "..."
}
```

Audit notification:

```json
{
  "streamSeq": 13,
  "source": "audit",
  "type": "computer.control_taken",
  "sourceSeq": 91,
  "at": "..."
}
```

System notifications include `connected`, `heartbeat`, and `session-ended`.

The stream does **not** contain:

- task input/result/progress data;
- audit actor/subject/data;
- action targets or page URLs;
- file contents;
- secret labels or values;
- browser snapshots;
- model context;
- bearer/operator/session tokens.

The browser uses the notification only to decide which authenticated read endpoint should be refreshed.

## Durable-before-notify rule

`TaskEventStore` and `AuditLog` notify subscribers only **after** their durable append succeeds.

Telemetry subscribers are observers. A subscriber exception is isolated and cannot turn an already-persisted task event or audit record into an application failure.

## Console refresh behavior

The console debounces refreshes instead of rerendering for every event.

- Overview/Tasks refresh on task events.
- Overview/Computers/Audit refresh on relevant audit signals.
- An open task detail dialog refreshes only when that task changes.
- Memory may refresh after task/audit signals that can accompany durable memory changes.
- **Policy draft is never auto-rerendered by telemetry.** In-progress draft text remains in browser memory until the operator navigates or explicitly resets it.

## Reconnection

Unexpected transport loss causes bounded exponential reconnect attempts using the same in-memory short-lived session token.

A server `session-ended` notification or an authentication refusal is treated as terminal for that session; the UI does not keep retrying an expired credential.

## Cleanup

Client disconnect, session expiry/revocation, or server-side termination removes task/audit listeners and timers. Listener counts are covered by regression tests to prevent abandoned browser tabs from leaking subscriptions.
