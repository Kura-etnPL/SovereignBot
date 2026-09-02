# Auto_Empire Desktop Handoff

Updated: 2026-09-03

- Branch: `codex/v4-review-directed-handoff-protocol`
- P17 source commits: `bbfab400d742c562aee2369b981c01c7ece1d2ba`, `6e309d3`, `f49f7d3`
- P18 source commit: `19d5421`
- Scope completed: P18 Trusted Production Channel-Unread Notification Producer, closing the explicit P17 limitation. Integrates ConversationStore message events via observer API in the main process. Implements fail-closed intent architecture where coworker messages notify only when explicit production call-site metadata sets `notifyChannelUnread === true`. Suppresses user self-messages, inactive coworkers, archived channels, and intermediate handoff/review/fanout protocol stages. Keeps `conversation:get` strictly read-only and resolves unread state solely via explicit bounded `conversation:acknowledge` IPC. Promise-chains acknowledgement in UI and synchronizes badge refresh with backend resolution. Supports in-place coalescing and reactivation upon new activity. Preserves digest dedupe key storage (`k_[a-f0-9]{32}`), collision-resistant opaque notification IDs (`notif_[a-f0-9]{16}`), and trusted-boundary redaction of secrets and absolute paths.
- Acceptance: `npm run verify:p18-channel-unread` → 10/10 PASS; `npm run verify:p17-notification-center` → 20/20 PASS; `node --test desktop/test/p18-channel-unread.test.mjs` → 9/9 PASS; `npm test` (desktop) → 276/276 PASS (0 fail); `npm test` (root) → 234/234 PASS (232 pass, 2 skipped, 0 fail); `npm run check` → syntax ok, 192 files; `npm run secret-scan` → clean; `git diff --check` → clean.
- Evidence: `_evidence_v57_2026-09-03/`; local unsigned evidence with `publishEligible=false`. The evidence commit is the final commit containing this handoff, the P18 acceptance document, and the evidence directory; its SHA is reported in the delivery summary.
- Channel-unread status: P17 limitation closed. Automated trusted main-process producer is active and verified in hidden Electron runtime.
- No provider, network, OAuth, cloud, remote, packaging, deployment, or account action was performed.
- Acceptance documents:
  - `docs/acceptance/V4.3-P18-CHANNEL-UNREAD-NOTIFICATIONS-ACCEPTANCE-2026-09-03.md`
  - `docs/acceptance/V4.3-P17-DESKTOP-NOTIFICATION-CENTER-ACCEPTANCE-2026-09-03.md`
