# SovereignBot 本地产品完成度总审计

## 1) 审计范围与证据标准

审计日期：2026-09-04（Asia/Shanghai）。权威目标是 canonical product plan：`C:\Users\Eternal\.codex\attachments\ddd527a5-594d-450b-b863-353be4c1161c\goal-objective.md`；权威 checkout 是 `E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention`，审计基线为 `0545d87bcd8f0541c7f2f15bb5a85c2d457c98a6`，工作树在提交前保持干净。

范围覆盖 canonical §§1–45 及 P0–P6 优先级，重点复核 Product Burst #118、Coworker/Team 协作、Provider adapter 边界、Projects/Memory/Search/Apps/Live Computer/Skills/Playbooks/Routines、Worker/External Control、可靠性/安全/性能/首启/Settings/Release readiness。没有启动 Electron，没有访问网络、Cloudflare、GitHub、Setup.exe、真实 Provider、浏览器登录或用户 SovereignBot 数据。

证据采用以下优先级：真实本地产品入口和 main/preload/IPC/schema 路径 > hidden Electron 或 packaged acceptance artifact > 真实 Core/Desktop canary 与 focused regression > 静态源码检查。`LOCAL_FIXTURE`、fake runtime、历史 acceptance 只能证明离线边界，不能升级为真实 Provider、真实账号、真实网络或正式发布证明。状态含义为：

- 已证实：当前源码中的产品路径、权威边界和已有 acceptance evidence 相互一致。
- 本地缺失/证据不足：能力尚未实现，或当前允许的本地证据仍不足；不以“搜不到 TODO”代替判断。
- 外部暂缓：本地实现或安全契约存在，但验收依赖用户明确禁止的账号、网络、设备、签名、Setup.exe、受保护 CI 或发布权限。

本次 Node-only 复核：root `npm test` 为 234 total / 232 pass / 2 skipped / 0 failed；desktop `npm test` 为 348 total / 347 pass / 1 skipped / 0 failed；desktop `npm run check` 为 301 files；desktop `npm run secret-scan` clean；`git diff --check` clean。跳过项是环境能力（Docker/symlink），不是被伪装成通过的产品结果。P36–P51 的机器证据均为 `ok:true`；最新 P51 为 [`verify-p51-routine-history.json`](verify-p51-routine-history.json)。

## 2) 已被当前证据证明完成的本地要求

| Canonical 要求 | 当前本地结论 | 证据 |
|---|---|---|
| §3 / P0 Playbook Library | 已证实：独立页面、create/edit/view、archive/restore、duplicate、Team/Channel assignment、import/export、semantic declarative fields；未引入第二 executor/DAG。 | [`V4.3-P22`](V4.3-P22-PLAYBOOK-LIBRARY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P12`](V4.3-P12-DESKTOP-SEMANTIC-PLAYBOOKS-ACCEPTANCE-2026-09-02.md)、`desktop/ui/product-hubs-ui.js`、typed Playbook IPC。 |
| §3 / P0 Files & Artifacts Hub | 已证实：独立 Hub、Recent/Team/Channel/Coworker/type 过滤、Preview/Open/Reveal、来源 Conversation、唯一 ArtifactStore、版本 History、Export、Archive/Restore、索引和 bounded content Search。 | [`V4.3-P24`](V4.3-P24-FILES-ARTIFACTS-COMPUTER-HISTORY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P26`](V4.3-P26-ARTIFACT-EXPORT-ACCEPTANCE-2026-09-03.md)、[`V4.3-P27`](V4.3-P27-ARTIFACT-RETENTION-ACCEPTANCE-2026-09-03.md)、[`V4.3-P42`](V4.3-P42-ARTIFACT-INDEX-ACCEPTANCE-2026-09-03.md)、[`V4.3-P45`](V4.3-P45-ARTIFACT-CONTENT-SEARCH-ACCEPTANCE-2026-09-03.md)。 |
| §3 / P0 Computer Activity History | 已证实：复用 Audit/Computer/Task/Takeover events 的安全 projection，显示 Coworker/time/app/site/action/status，并过滤 secret/cookie/session/coordinates/WebDriver internals。 | [`V4.3-P24`](V4.3-P24-FILES-ARTIFACTS-COMPUTER-HISTORY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P35`](V4.3-P35-THIS-PC-DEEP-LINKS-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/product-surface-service.js`。 |
| §3 / P0 Skill Library | 已证实：create/edit/Teach Once/test/retest/duplicate/archive/restore/import/export、Team/Coworker assignment、Create Routine；`requestedCapabilities` 不是 grant，导入不能 mint capability。 | [`V4.3-P23`](V4.3-P23-SKILL-LIBRARY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P49`](V4.3-P49-MEMORY-DIALOGS-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/skill-store.js`、`desktop/src/main/skill-file-io.js`。 |
| §3 / P0 Team Pack Gallery | 已证实：Software/Research/Content/Operations 以及 Product/Revenue/Support first-party recipes；Install/Import/Export/Duplicate/custom Edit/Search/Filter，first-party read-only，普通 entity 创建且不带权限。 | [`V4.3-P11`](V4.3-P11-DESKTOP-FIRST-PARTY-TEAM-PACKS-ACCEPTANCE-2026-09-02.md)、[`V4.3-P20`](V4.3-P20-TEAM-PACK-FILE-FLOW-ACCEPTANCE-2026-09-03.md)、[`V4.3-P21`](V4.3-P21-TEAM-PACK-RECIPE-EDITOR-ACCEPTANCE-2026-09-03.md)、[`V4.3-P31`](V4.3-P31-TEAM-PACK-GALLERY-CONSISTENCY-ACCEPTANCE-2026-09-03.md)。 |
| §3 / P0 Channels | 已证实本地：New/Edit、archive/restore、template create/use、quick-switch、unread/last activity 均有现成产品控件、typed preload/IPC 和独立 hidden Electron click-path gate；archive/includeArchived、restart persistence、stale/archived fail-closed 与 public redaction 也纳入同一验收入口。 | [`V4.3-P19`](V4.3-P19-PRODUCT-BURST-AUDIT-CHANNEL-EDITOR-ACCEPTANCE-2026-09-03.md)、[`Channels 产品路径验收`](channels-product-path-acceptance-2026-09-04.md)、[`Channels gate JSON`](verify-channels-product-path.json)、`desktop/src/main/verify-channels-product-path.js`、`desktop/src/main/team-service.js`、`desktop/ui/product-hubs-ui.js`。 |
| §3 / P0 External Control | 已证实本地边界：bounded 14-operation legacy loopback + paired direct/opaque relay facade、scope/team/project binding、replay/tamper/downgrade/revoke/capacity denial、public projections 和生产 startup attach。 | [`V4.3-P1`](V4.3-P1-EXTERNAL-CONTROL-PLANE-ACCEPTANCE-2026-09-02.md)、`desktop/src/main/index.js:542`、`desktop/src/main/external-team-control.js`、`src/remote-controller-contract.js`。真实远程设备/relay 仍见第 4 节。 |
| §4–§6 Coworker、Team、动态协作、ModelBinding | 已证实本地：durable Coworker/Team/Channel、owner routing、DM/@mention/reply、directed handoff、review、bounded parallel specialists、join/stop、stale lineage、每 Coworker 的 safe ModelBinding projection 和 no-downgrade 规则。 | [`V4.3-P13`](V4.3-P13-DESKTOP-DIRECTED-COLLABORATION-ACCEPTANCE-2026-09-02.md)、[`V4.3-P14`](V4.3-P14-DESKTOP-PARALLEL-SPECIALISTS-ACCEPTANCE-2026-09-02.md)、[`V4.3-P16`](V4.3-P16-DESKTOP-TEAM-ACTIVITY-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/team-service.js`、`src/orchestrator.js`。真实 Provider useful work 不在本地证明范围。 |
| §11–§12 Memory、Projects/Workspace | 已证实本地：Coworker/Team/Project scope、source trace、edit/delete/forget/pin、relevance/index、Project switcher/create/archive/restore/export/backup、bounded command center、restart persistence 和 unavailable fail-closed。 | [`V4.3-P25`](V4.3-P25-MEMORY-EDITOR-ACCEPTANCE-2026-09-03.md)、[`V4.3-P34`](V4.3-P34-PROJECTS-EXPORT-ACCEPTANCE-2026-09-03.md)、[`V4.3-P40`](V4.3-P40-MEMORY-RELEVANCE-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/memory-service.js`、`desktop/src/main/project-service.js`。 |
| §13–§15 This PC、Computer abstraction、Worker Node | 已证实本地：This PC safe status/frame/history/takeover/hand-back；统一 target controller；loopback Worker Node health/action/job/routine/trigger/team path、idempotency、cancel、capacity、no-local-fallback。LocalIsolated 属于 P5 可选目标；其当前环境 Docker 复现不作为 Windows V4 blocker。 | [`V4.3-P35`](V4.3-P35-THIS-PC-DEEP-LINKS-ACCEPTANCE-2026-09-03.md)、[`V4.2-P4 Worker Computer`](V4.2-P4-WORKER-COMPUTER-ACCEPTANCE-2026-09-02.md)、`desktop/src/main/computer-target-controller.js`、`desktop/src/main/worker-node-store.js`。 |
| §17 Connected Apps / §18 bounded Apps Catalog | 已证实本地 bounded catalog：This PC/workspace first-party apps、search/filter、review-before-connect、cost/approval、Team/Coworker/Project assignment、connect/disconnect/disable、restart 和 safe health projection。canonical §18 明确不要求重建 500-App 平台；更广 third-party catalog 属于 §42 后续扩展，不是当前 Windows V4 blocker。 | [`V4.2-P7.2 Apps Catalog`](V4.2-P7.2-DESKTOP-APPS-CATALOG-ACCEPTANCE-2026-09-02.md)、[`V4.3-P32`](V4.3-P32-APPS-CATALOG-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/connected-apps.js`、canonical §18/§42。 |
| §19–§22 Skills、Playbooks、Routines、Event Triggers | 已证实本地：Skill execution 重新走 Coworker+Governor；Playbook declarative semantics；one-time/daily/weekly/custom durable scheduling、history/retry、Skill/Team Routine；workspace file trigger、debounce/storm guard、normal governed Job。 | [`V4.2-P3`](V4.2-P3-SKILLS-PLAYBOOKS-ROUTINES-ACCEPTANCE-2026-09-02.md)、[`V4.3-P46`](V4.3-P46-TRIGGER-WORKSPACE-LABEL-ACCEPTANCE-2026-09-03.md)、[`V4.3-P47`](V4.3-P47-ROUTINE-LIFECYCLE-ACCEPTANCE-2026-09-03.md)、[`verify-p51-routine-history.json`](verify-p51-routine-history.json)。 |
| §23–§24 Artifacts、Search、Command Palette | 已证实本地：canonical ArtifactStore、bounded indexes、full retained Conversation search、safe snippets/match reasons、8 search types、7 fixed palette actions、exact deep links、pagination/restart/invalidation。 | [`V4.3-P33`](V4.3-P33-SEARCH-PALETTE-ACCEPTANCE-2026-09-03.md)、[`V4.3-P39`](V4.3-P39-CONVERSATION-PAGINATION-ACCEPTANCE-2026-09-03.md)、[`V4.3-P44`](V4.3-P44-CONVERSATION-SEARCH-ACCEPTANCE-2026-09-03.md)、[`V4.3-P45`](V4.3-P45-ARTIFACT-CONTENT-SEARCH-ACCEPTANCE-2026-09-03.md)。 |
| §25 Attention / §33 Notifications | 已证实本地：Attention/approval/secret/takeover/failure paths、local allowlisted categories、dedupe、preferences、channel-unread trusted producer、bounded public projections 和 stale refresh guards。 | [`V4.3-P8`](V4.3-P8-ATTENTION-APPROVAL-ACCEPTANCE-2026-09-02.md)、[`V4.3-P17`](V4.3-P17-DESKTOP-NOTIFICATION-CENTER-ACCEPTANCE-2026-09-03.md)、[`V4.3-P18`](V4.3-P18-CHANNEL-UNREAD-NOTIFICATIONS-ACCEPTANCE-2026-09-03.md)。 |
| §34 Reliability / §35 Performance & Scale | 已证实本地：migration transaction、backup/restore/export/reset、restart/idempotency/rollback/stale-lineage、50+ roster bounded disclosure、300-message renderer window、Artifact/Search indexing、no session explosion。 | [`V4.2-P6`](V4.2-P6-RELIABILITY-DATA-LIFECYCLE-ACCEPTANCE-2026-09-02.md)、[`V4.3-P39`](V4.3-P39-CONVERSATION-PAGINATION-ACCEPTANCE-2026-09-03.md)、[`V4.3-P41`](V4.3-P41-COWORKER-ROSTER-ACCEPTANCE-2026-09-03.md)、[`V4.3-P42`](V4.3-P42-ARTIFACT-INDEX-ACCEPTANCE-2026-09-03.md)、[`V4.3-P43`](V4.3-P43-SEARCH-INDEX-ACCEPTANCE-2026-09-03.md)。 |
| §36 Security / Governance、§37 Testing Policy | 已证实本地：Intelligence != Authority、Governor、fail-closed、single owner、task-bound Computer、secret channel、hash-chain audit、repeat guard、credential/ProviderAccount/workspace/browser isolation、import/external-control redaction；测试以真实路径、invariant 和 targeted regression 为主。 | `src/governor.js`、`src/policy.js`、`src/audit.js`、`src/worker-secure-transport.js`、当前 root/Desktop suites、各 acceptance artifact 的 `fixtureBoundary=LOCAL_FIXTURE` 和 `publishEligible=false`。 |
| §38 First-run / §39 Settings | 已证实本地：fresh isolated Welcome、Install/Create Coworker、honest disconnected provider states、normal/Advanced hierarchy、model/computer/apps/notifications/backup/update/voice controls。 | [`V4.3-P36`](V4.3-P36-FIRST-RUN-ONBOARDING-ACCEPTANCE-2026-09-03.md)、[`V4.3-P37`](V4.3-P37-SETTINGS-HIERARCHY-ACCEPTANCE-2026-09-03.md)、`desktop/ui/index.html`、`desktop/ui/app.js`。真实登录和设备权限另列第 4 节。 |
| §43 Fast-path、§44 Priority、§45 North Star | 已证实架构遵守复用现有 Governor/Job/Computer/Artifact/Notification/External Control primitives；交付顺序已覆盖 P0 Product Burst、P1 协作、P3 breadth、P4/P5 边界和 P6 本地可靠性机制，且产品体验仍以 Coworkers/Channels/Projects/Computer/Apps/Skills/Routines/Files/Attention 为中心。 | canonical plan 与当前 `handoff/HANDOFF.md`；P0/P1/P3/P4/P5/P6 acceptance 文档和当前源码入口。 |

## 3) 真正缺失或证据不足的本地要求

当前 Windows-first V4 本地产品收口缺口数量：0 项。Update Apply 与 Channels 的最后本地 UX/证据闭环均已实现，并分别提供了产品能力级验收入口；对应的本地 gate 证据为 [`Update Apply gate JSON`](verify-update-apply-dialog.json) 和 [`Channels gate JSON`](verify-channels-product-path.json)。本结论不等同于正式 V4 release 完成。

以下 post-V4 / optional 能力仍明确不计入当前本地 blocker：更完整 third-party Apps catalog、LocalIsolated Docker 的当前环境重跑、Native Android package、Cloud Computer runtime、Voice Call/telephony、macOS/Linux Desktop packaging。它们已在 canonical §42 或 P5 optional targets 中被划出当前 Windows V4 范围。

## 4) 用户明确暂缓的外部要求

以下事项不是本地源码缺口的偷换说法，而是用户明确禁止或当前环境无法安全执行的外部证明；数量按独立验收责任计 7 项。

| Deferred 外部事项 | 当前事实与未执行内容 |
|---|---|
| 真实 Provider 登录与长期 useful-work | Codex、ChatGPT Web/Sol、Antigravity A/B/C 的 adapter/continuity/health/isolation contract 有 local fake proof；未登录真实账号、未运行真实 Provider long-run、未验证真实 Deep/Efficient routing。Economy 也未连接 metered provider。 |
| Windows Setup.exe fresh install / upgrade | 可生成或已有本地 packaging/release mechanics，但按用户要求未运行 Setup.exe、未安装现有用户环境、未做 fresh disposable profile 的真实 Squirrel install/upgrade。 |
| Authenticode signing | 当前 RC intentionally unsigned；没有证书、signtool authority 或签名凭据。 |
| Protected current-main / merged-PR provenance 与 GitHub Release | 未 fetch/push/PR/merge、未触碰 main、未上传 GitHub Release；`publishEligible=false` 只能表示本地状态，不是正式发布。 |
| 真实 LAN/remote relay/multi-machine pairing | LAN/remote opaque transport、pairing、replay/tamper/downgrade/revoke contract 在内存/本地 fixture 通过；没有真实多机 socket、NAT、relay service 或 Cloudflare deployment。 |
| Android/Web remote controller real device and host pairing | Controller UI/contract 与本地 direct/opaque relay fixture 通过；没有 Android SDK/APK、真实设备、native host、设备密钥或远程网络 pairing。 |
| OS hardware/provider permissions | 未做真实 microphone/speaker permission、真实 screen/device capture、真实 browser account/session、外部 App OAuth 或云费用验证；Web Speech 与 This PC 的本地安全 projection 不等于硬件/账号验收。 |

## 5) 一个有上限的剩余本地工作清单

当前 Windows V4 本地剩余工作上限为 0 个产品能力；不新增 P 编号，也不把 verifier/test script correction 拆成产品项。§42 的 post-V4 能力和 P5 optional targets 不计入本清单。

无。当前本地产品收口已完成；剩余未验证事项仅属于第 4 节 external deferred，或属于明确的 post-V4 / optional expansion。

达到这份清单的本地证据要求，仍不会自动完成第 4 节的真实账号、网络、设备、签名或发布事项；那些必须由用户另行解除限制并单独验收。
