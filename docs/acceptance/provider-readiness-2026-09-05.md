# Provider readiness and next delivery boundary

Verified 2026-09-05. This supplements the local-product completion audit; local
fixture coverage does not establish a working production provider.

## Current user scope

Real Codex execution is authorized only with `gpt-5.6-luna`; ChatGPT **Chat** may
use Sol, never Work. No automatic upgrade or paid fallback. Prioritize ChatGPT Web, then OpenCode free-model integration and
OpenCode Go, with Antigravity later. Existing project data need not block ordinary
development, but unrelated data/accounts and release actions remain out of scope.

## Implemented and verified locally

The former ChatGPT adapter advertised a static model, extracted whole-page text,
and used competing drivers for one account profile. It now checks a fixed public
DOM projection, verifies Chat mode and the selected model before typing, and
returns only a new completed assistant message. Partial, stale, oversized and Work
responses fail closed. Login/execution share one serialized owned driver; cancel
aborts locally and retains the lock until execution unwinds. Each coworker keeps
its own account-scoped persisted conversation reference. No cookies/private APIs.

The ordinary login action now enables subsequent refresh without requiring an
environment flag; a connected profile is recognized on restart but is not labeled
ready until checked. Driver configuration is resolved at login time, so provisioning
after startup is visible. Automatic provisioning detects the actual Windows Chrome
layout and prefers matching build versions; it no longer claims ChromeDriver can
serve Edge. Official CfT has no `.sha256` companion for the tested archive; its HTTPS
Google Storage MD5 transfer checksum is verified and recorded as `gcs-md5`, with
local SHA-256 retained separately. This is integrity checking, not code signing.

Real Luna-only Software Team run: `temp/live-luna-voSVBL/evidence/live-result.json`.
All nine configured Codex identities were pinned to `gpt-5.6-luna` before sending.
Chief implemented, Reviewer independently reviewed, then Chief completed and
attached `math_helper.mjs`. Parent separately ran eight Node assertions successfully.
The requested Coding Lead was not selected in this run; do not count that route
as verified. The earlier Python run timed out during Chief synthesis and is retained
as a failed attempt (`temp/live-luna-WAV2Ew`), not a success.

The successful run's completed task, conversation and artifact preview survived
production Electron restart: `temp/live-luna-voSVBL/evidence/restart-result.json`.
That check exposed and fixed missing `.mjs`/`.cjs` MIME handling, including legacy
generic metadata. This proves completed-state persistence, **not mid-task crash
recovery**. The channel screenshot was visually inspected; it is a collaboration
snapshot, not proof of the final completion state.

Targeted desktop provider/economy/roster tests: 34 passed; artifact tests: 9 passed;
driver provisioning tests: 7 passed; coworker-binding/first-run/provider batch: 18
passed (overlaps provider tests). Core harness/sidecar tests: 7 passed. Desktop
syntax check: 311 files. These fixture counts do not replace the real-run evidence.

## Live boundary and remaining blockers

### Restart recovery follow-up

The interrupted real Luna run `temp/live-luna-WAV2Ew` now recovers its exact
task-linked recipient to Attention and cancels the stale execution without adding
tasks or replaying provider work. Production Electron inspection passed five
checks in `temp/live-luna-WAV2Ew/evidence/interrupted-result.json`; the channel and
Redirect button were visually confirmed in `interrupted-recovery.png`. Reopening
the recovered state exposed a load-time status filter that discarded Attention
and Redirected; both now persist across reload. Relevant store tests: 9 passed;
dispatcher and sidecar tests: 12 passed. No live model prompt was sent for these
restart inspections. Follow-up live attempts exposed forced pack sequencing,
new-run recipient/owner disagreement, and a composer branch that sent an ordinary
message instead of redirecting recovered Attention. These are now fixed. The final
Luna-only redirect completed with Chief reply `msg_68b766d2f3fb4791`, exactly one
new work task, no specialist launch, no pending delivery and no recovered Attention.
Evidence: `recovery-redirect-result.json` (11 checks passed). A separate restart
preserved completion/reply and kept Redirect hidden: `reply-only-restart-result.json`
(4 checks passed), with `reply-only-completed.png` visually inspected.

Reply-only completion is explicit structured model intent, not a text heuristic.
The trusted team service requires current owner/message and all five version/run/
request/operation proofs, and denies active protocols, fanout and run artifacts.
Conflicting manifests are rejected. Existing artifact review and fanout paths stay
intact. Focused collaboration/recovery/manifest/team tests: 43 passed. Restart also
handles a completed provider task whose conversation delivery never published;
it preserves the result and requests attention rather than executing it again.

The real channel exposed two further UI defects, now fixed: double-escaped inline
code/underscore parsing (plus generated syntax-highlight markup corruption), and
the hidden demo banner shifting the message scroller into an unbounded grid row.
The composer previously began at y=802 in an 802px viewport; it now occupies
y=597–802. The revised channel screenshot was visually checked; six recovery/UI
checks and four Markdown regressions passed. Explicit redirects also clear the
old recovered Attention delivery rather than retaining a stale action indefinitely.
Settings and palette appearance now agree after asynchronous startup, preventing
white labels on a light sidebar. System-mode switching retains the preferred
palette without overwriting it; the focused theme regression passed.

OpenCode continuation now uses the existing atomic desktop-state persistence,
partitioned by provider, mode, model, account namespace and credential fingerprint.
Runtime host passes its actual dataDir to the factory. Reload/account-switch,
concurrent-call isolation and failed/cancelled response tests plus Economy canaries
passed (17 tests). No raw credential is stored and no live OpenCode call was made.

Background schedulers wait for recovery; conversation-store decorators preserve
the listing API used to identify affected messages. Normal browser shutdown now
waits for session teardown, with a real owned about:blank browser leaving zero
profile-matched Chrome processes. Forced OS termination cleanup is not proven.

Follow-up: the user-authorized scoped Mihomo DNS repair resolved the Fake-IP
block below. The production browser now reaches ChatGPT's `请稍候…` site-check
page and stops there. See `chatgpt-dns-repair-2026-09-05.md`; live authenticated
adapter execution remains unverified.

1. In a new Codex in-app browser Chat, Sol was explicitly selected and returned
   `SB_WEB_SOL_OK`. Public DOM confirmed the assistant-only response and completion
   control. This is a **browser UI probe**, not SovereignBot's production adapter
   end-to-end verification and not a login transferable to its dedicated profile.
2. Production W3C connection probe downloaded/verified ChromeDriver 152.0.7977.82
   and started the driver. Navigation failed because local DNS resolves chatgpt.com
   to **198.18.0.30**, an always-blocked egress address. Read-only network inspection
   also found an active Mihomo adapter; proxy fake-IP is the likely cause, not yet a
   proven configuration diagnosis. Evidence:
   `temp/chatgpt-connection-2AQ3rC/connection-result.json`.
   No prompt was sent, no safety block bypassed, no system proxy changed. The helper
   closed its browser/sidecar. Network configuration must be resolved within the
   user's authorization before live adapter sign-in and continuation testing.
3. OpenCode is wired into the existing Economy factory, opt-in and bounded to fixed
   official Zen-free/Go routes. No Zen credential was found. The existing Go key is
   kept separate, and live Go remains blocked until Use balance is confirmed off.
   No OpenCode live call, purchase, subscription change or credential disclosure.
4. Mid-task crash/resume, redirect follow-through, full Apps/Computer/Teach Once
   live chain, AGY live integration and the complete release roadmap are not proven.
   No installed app replacement, Setup.exe, GitHub write, deployment or release.

## Product comparison (official sources checked)

- [Grok Bot introduction](https://x.ai/news/introducing-grok-bot): independently
  coordinated teammates, group-chat ownership/handoffs, work in real applications,
  reusable demonstrated workflows, and persistent context. These are concrete
  acceptance goals, not proof that SovereignBot already matches or surpasses it.
- [OpenAI authentication](https://learn.chatgpt.com/docs/auth): Codex subscription
  sign-in and ChatGPT browser sign-in are distinct client paths. The page does not
  establish a supported third-party ChatGPT Web provider API.
- [OpenCode Go](https://opencode.ai/docs/go/): subscription provider; documented
  optional Zen balance fallback must not be assumed free.
- [OpenCode Zen](https://opencode.ai/docs/zen/): both free and paid models; free
  availability can be temporary. Do not assume every OpenCode model is free.
- [ChromeDriver selection](https://developer.chrome.com/docs/chromedriver/downloads/version-selection):
  installed MAJOR.MINOR.BUILD matching before milestone fallback.
- [Google Storage checksums](https://docs.cloud.google.com/storage/docs/data-validation):
  transfer integrity checks; not a software signature or independent release attestation.

The complete 45-section canonical roadmap remains unfinished. This document does
not mark the blocked Codex goal active or complete, and does not replace the goal.
