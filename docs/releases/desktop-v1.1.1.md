# SovereignBot Desktop 1.1.1

v1.1.1 corrects the Desktop provider wiring and release provenance gaps in v1.1.0.

The `desktop-v1.1.0` tag, release, and assets remain published and immutable as history; nothing was moved or rewritten. This version exists because an independent acceptance review of the shipping v1.1.0 tree established that its "product-complete" claim did not hold: the runtime only ever constructed Echo agents, the goal pipeline silently fell back to Echo demos, workspace selection never reached provider processes, and a tag push from any branch could reach a privileged publish job. Every finding is fixed here with reproducible tests.

## What is actually true in 1.1.1

- **Real Codex/Claude roster in normal mode.** The runtime is built FROM passive provider discovery plus validated settings: per-provider enable flags and role assignment (planner / worker / reviewer / synthesizer) constrained to main-generated identities with distinct ids per role and cross-provider defaults. Normal mode contains zero Echo agents; Demo Mode is the only explicit Echo path and says so on screen.
- **Trusted workspace execution.** The folder you pick is canonicalized into the trusted registry; every planner, worker, reviewer, and synthesis launch runs with exactly that directory as the provider child process cwd through an internal-only Core channel that public surfaces cannot forge. Replaced or moved folders fail closed per launch.
- **A real goal pipeline.** Planning runs on a real planner agent; its proposal is untrusted data validated strictly (unknown capabilities, duplicate keys, missing instructions, forward dependencies, oversize, authority-bearing fields all reject) with bounded repair — no silent single-step fallback. Workers get concrete instructions and public dependency results. Reviewed steps get an independent reviewer identity whose strict decision JSON drives bounded retry that resumes the same provider session. Synthesis is a real synthesizer task over public results.
- **Provenance you can check.** Publication happens only after a read-only verify job proves the candidate is current `main` AND the merge commit of a reviewed PR, re-runs unit tests, packaging, fuse verification, secret scan, and the fake-provider installed E2E, then hands immutable artifacts to a publish job that never rebuilds, refuses moved tags, and refuses release overwrites. `release-manifest.json` binds artifact SHA-256s to the exact commit, pinned Electron zips, the internal Node runtime manifest, and the vendored Core manifest.
- **Evidence, not claims.** CI installs the Setup.exe on a clean Windows runner and drives a full goal — planner proposal → worker DAG → independent review with one changes_requested cycle → synthesis — through contract-exact fake Codex/Claude CLIs inside the installed app, asserting transcript phase coverage, child-cwd equality with the chosen workspace, session-resume continuity, zero Echo participation, and no raw session id in any public surface.

## Honest limitations

- The binary is not code-signed; SmartScreen may warn on first run. Verify `SHA256SUMS.txt` before running.
- Real-account smoke (your own logged-in Codex/Claude) stays optional and manual; the shipped evidence gate uses contract fakes so no quota is consumed by CI.
- Browser-governed tooling requires provisioning a managed ChromeDriver (verified against the vendor digest) and applies least-privilege to the worker identity only.

## Install

Download `SovereignBot-1.1.1.Setup.exe`, verify its SHA-256 against `SHA256SUMS.txt`, double-click to install, then start SovereignBot from the Start menu. Connect at least one AI provider from Home → AI workers (sign-in opens your provider CLI's own login flow; SovereignBot never sees credentials), add a workspace folder, and submit a goal.
