# Contributing

Contributions are welcome. SovereignBot is intentionally small at v0.1 so that security and runtime invariants remain reviewable.

## Development

```bash
npm run check
npm test
```

Pull requests should include tests for behavior changes. Changes to policy, audit, harness execution, networking, or secret handling should explain the threat model and failure mode in the PR description.

## Design rule

Do not couple the core runtime to one model vendor, paid API, hosted memory service, or agent protocol. Integrations belong behind adapters.
