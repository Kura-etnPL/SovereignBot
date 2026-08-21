# Policy draft editor and dry-run explain

SovereignBot's operator console includes a policy draft editor for validation and simulation. Dry-run remains deliberately side-effect free even though the console now has a separate, explicit versioned Apply/Rollback authority path.

## Draft and dry-run

The Policy view can:

- load the active runtime policy as a JSON snapshot;
- edit that snapshot in browser memory;
- validate rule structure and supported match fields;
- simulate a documented action context;
- choose a simulated `repeatCount`;
- explain deny-rule evaluation before allow-rule evaluation;
- show the rule that would allow or deny the simulated action;
- show which condition names prevented a rule from matching;
- simulate the hard-safety deny path.

Dry-run does **not**:

- modify the live PolicyEngine;
- move the durable active-policy pointer;
- create a policy version;
- write the config file;
- observe or increment the production repeat counter;
- write `repeat-state.json`;
- append `action.allowed` or `action.denied` audit rows;
- launch a harness;
- perform a computer, browser, network, file, task, lifecycle, or secret action.

The browser keeps the draft in current-page JavaScript memory only. Telemetry does not auto-rerender the Policy page, so an in-progress draft is not overwritten by background events. A full page refresh discards the browser-memory draft.

## Evaluation order

Dry-run follows the live policy decision order:

1. hard safety invariant;
2. matching deny rules, in draft order;
3. matching allow rules, in draft order;
4. default fail-closed deny.

The supplied `repeatCount` is treated as the already-counted current attempt. It does not read or modify the durable repeat store.

## Explain output

Explain rows include only:

- stage;
- rule id;
- effect;
- whether the rule matched;
- names of conditions that failed.

Action values are deliberately not copied into the explain response. This prevents arbitrary simulated fields such as passwords, bearer tokens, URL query secrets, or metadata from being reflected back as an explanation trace.

Hard-safety simulation also returns a fixed generic reason rather than echoing the caller-provided `hardDeny` text.

## Draft validation

The draft validator fails closed on:

- unsupported policy fields;
- unsupported rule fields;
- unsupported match fields;
- duplicate rule ids;
- effects other than `allow` or `deny`;
- invalid string/array match values;
- non-positive `repeatAtLeast` values;
- invalid repeat window/cardinality configuration.

Failing on unknown fields is intentional. A misspelled policy field must not appear to work while being silently ignored.

## Relationship to Apply

Apply is a separate operator-only transaction described in [policy-activation.md](policy-activation.md).

The console does not enable **Apply checked policy** until a dry-run has been performed against the current draft/action/repeatCount. Editing any of those inputs invalidates that browser-side result.

The browser result is not trusted as the authorization proof. On Apply, the browser sends the simulated action plus the expected `allowed` result and optional `ruleId`; the server runs `dryRunPolicy()` again against the submitted draft. A mismatch fails before an immutable policy version is created.

This makes dry-run a required precondition/check for the UI workflow while keeping the dry-run endpoint itself pure.

## Repeat-safety settings

`repeatWindowMs` and `repeatMaxActiveFingerprints` configure the persistent RepeatStore. They are validated in drafts, but changing them during a live activation is refused because the existing repeat state was created under the current settings.

Those two values are restart/migration-level safety settings, not ordinary hot policy fields. Live Apply/Rollback requires the target version to use the same effective repeat-store settings as the currently active version.

## Hard safety is not editable policy

Runtime hard denials remain outside the versioned policy document. An operator policy version cannot weaken or override those hard-safety invariants.
