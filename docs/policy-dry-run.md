# Policy draft editor and dry-run explain

SovereignBot's operator console includes a policy **draft** editor for validation and simulation.

This surface is intentionally not a live policy editor.

## What it can do

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

## What it cannot do

There is no Apply, Save, Reload, or Activate endpoint in this milestone.

Dry-run does **not**:

- modify `runtime.config.policy`;
- replace `runtime.governor.policy`;
- write the config file;
- observe or increment the production repeat counter;
- write `repeat-state.json`;
- append `action.allowed` or `action.denied` audit rows;
- launch a harness;
- perform a computer, browser, network, file, task, lifecycle, or secret action.

The browser keeps the draft in current-page JavaScript memory only. A page refresh discards it.

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

## Future live apply

A future policy-apply feature should be a separate authority-sensitive change. It will need, at minimum:

- explicit operator confirmation;
- validated policy versioning;
- transactional persistence;
- rollback;
- audit records for proposed/applied versions;
- safe runtime reload semantics;
- protection against weakening hard-safety invariants;
- clear behavior for in-flight tasks.

The dry-run endpoint should remain side-effect free even after live apply exists.
