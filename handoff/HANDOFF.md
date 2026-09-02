# Auto_Empire Desktop Handoff

Updated: 2026-09-03

- Branch: `codex/v4-review-directed-handoff-protocol`
- P17 initial source commit: `bbfab400d742c562aee2369b981c01c7ece1d2ba`
- P17 corrective source commit: `6e309d3`
- Scope completed: first-class local Desktop Notification Center with prominent sidebar entry/badge, bounded newest-first inbox, category and read/unread filtering, durable mark read/unread, mark all visible read, dismiss one/all, OS popup preference preservation, safe host event-based conversation and Routines navigation, removal of internal keys from public projections in favor of collision-resistant opaque IDs, exact safe source projections, trusted boundary secret and absolute-path redaction across disk/public/popup data, monotonic refresh generation guard, ordinary UI copy without storage paths, and restart persistence.
- Acceptance: `npm run verify:p17-notification-center` → 19/19 PASS; `npm test` (desktop) → 267/267 PASS; `npm test` (root) → 234/234 PASS (232 pass, 2 skipped, 0 fail); `npm run check` → syntax ok, 187 files; `npm run secret-scan` → clean; `git diff --check` → clean.
- Evidence: `_evidence_v56_2026-09-03/`; local unsigned evidence with `publishEligible=false`. The evidence-only commit is the final commit containing this handoff, the P17 acceptance document, and the evidence directory; its SHA is reported in the delivery summary.
- Channel-unread limitation: category is allowlisted and supported in data models, UI, and filters, but has no automated production main-process hook wired yet.
- No provider, network, OAuth, cloud, remote, packaging, deployment, or account action was performed.
- Acceptance document: `docs/acceptance/V4.3-P17-DESKTOP-NOTIFICATION-CENTER-ACCEPTANCE-2026-09-03.md`.
