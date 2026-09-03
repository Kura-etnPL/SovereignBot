# SovereignBot 本地产品完成度总审计

## 1) 审计范围与证据标准

审计日期：2026-09-04（Asia/Shanghai）。权威目标是 canonical product plan：`C:\Users\Eternal\.codex\attachments\ddd527a5-594d-450b-b863-353be4c1161c\goal-objective.md`；权威 checkout 是 `E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention`，审计基线为 `0545d87bcd8f0541c7f2f15bb5a85c2d457c98a6`，工作树在提交前保持干净。

范围覆盖 canonical §§1–45 及 P0–P6 优先级，重点复核 Product Burst #118、Coworker/Team 协作、Provider adapter 边界、Projects/Memory/Search/Apps/Live Computer/Skills/Playbooks/Routines、Worker/External Control、可靠性/安全/性能/首启/Settings/Release readiness。没有启动 Electron，没有访问网络、Cloudflare、GitHub、Setup.exe、真实 Provider、浏览器登录或用户 SovereignBot 数据。

证据采用以下优先级：真实本地产品入口和 main/preload/IPC/schema 路径 > hidden Electron 或 packaged acceptance artifact > 真实 Core/Desktop canary 与 focused regression > 静态源码检查。`LOCAL_FIXTURE`、fake runtime、历史 acceptance 只能证明离线边界，不能升级为真实 Provider、真实账号、真实网络或正式发布证明。状态含义为：

- 已证实：当前源码中的产品路径、权威边界和已有 acceptance evidence 相互一致。
- 本地缺失/证据不足：能力尚未实现，或当前允许的本地证据仍不足；不以“搜不到 TODO”代替判断。
- 外部暂缓：本地实现或安全契约存在，但验收依赖用户明确禁止的账号、网络、设备、签名、Setup.exe、受保护 CI 或发布权限。

本次 Node-only 复核：root `npm test` 为 234 total / 232 pass / 2 skipped / 0 failed；desktop `npm test` 为 343 total / 342 pass / 1 skipped / 0 failed；desktop `npm run check` 为 293 files；desktop `npm run secret-scan` clean；`git diff --check` clean。跳过项是环境能力（Docker/symlink），不是被伪装成通过的产品结果。P36–P51 的机器证据均为 `ok:true`；最新 P51 为 [`verify-p51-routine-history.json`](verify-p51-routine-history.json)。

## 2) 已被当前证据证明完成的本地要求

| Canonical 要求 | 当前本地结论 | 证据 |
|---|---|---|
| §3 / P0 Playbook Library | 已证实：独立页面、create/edit/view、archive/restore、duplicate、Team/Channel assignment、import/export、semantic declarative fields；未引入第二 executor/DAG。 | [`V4.3-P22`](V4.3-P22-PLAYBOOK-LIBRARY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P12`](V4.3-P12-DESKTOP-SEMANTIC-PLAYBOOKS-ACCEPTANCE-2026-09-02.md)、`desktop/ui/product-hubs-ui.js`、typed Playbook IPC。 |
| §3 / P0 Files & Artifacts Hub | 已证实：独立 Hub、Recent/Team/Channel/Coworker/type 过滤、Preview/Open/Reveal、来源 Conversation、唯一 ArtifactStore、版本 History、Export、Archive/Restore、索引和 bounded content Search。 | [`V4.3-P24`](V4.3-P24-FILES-ARTIFACTS-COMPUTER-HISTORY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P26`](V4.3-P26-ARTIFACT-EXPORT-ACCEPTANCE-2026-09-03.md)、[`V4.3-P27`](V4.3-P27-ARTIFACT-RETENTION-ACCEPTANCE-2026-09-03.md)、[`V4.3-P42`](V4.3-P42-ARTIFACT-INDEX-ACCEPTANCE-2026-09-03.md)、[`V4.3-P45`](V4.3-P45-ARTIFACT-CONTENT-SEARCH-ACCEPTANCE-2026-09-03.md)。 |
| §3 / P0 Computer Activity History | 已证实：复用 Audit/Computer/Task/Takeover events 的安全 projection，显示 Coworker/time/app/site/action/status，并过滤 secret/cookie/session/coordinates/WebDriver internals。 | [`V4.3-P24`](V4.3-P24-FILES-ARTIFACTS-COMPUTER-HISTORY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P35`](V4.3-P35-THIS-PC-DEEP-LINKS-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/product-surface-service.js`。 |
| §3 / P0 Skill Library | 已证实：create/edit/Teach Once/test/retest/duplicate/archive/restore/import/export、Team/Coworker assignment、Create Routine；`requestedCapabilities` 不是 grant，导入不能 mint capability。 | [`V4.3-P23`](V4.3-P23-SKILL-LIBRARY-ACCEPTANCE-2026-09-03.md)、[`V4.3-P49`](V4.3-P49-MEMORY-DIALOGS-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/skill-store.js`、`desktop/src/main/skill-file-io.js`。 |
| §3 / P0 Team Pack Gallery | 已证实：Software/Research/Content/Operations 以及 Product/Revenue/Support first-party recipes；Install/Import/Export/Duplicate/custom Edit/Search/Filter，first-party read-only，普通 entity 创建且不带权限。 | [`V4.3-P11`](V4.3-P11-DESKTOP-FIRST-PARTY-TEAM-PACKS-ACCEPTANCE-2026-09-02.md)、[`V4.3-P20`](V4.3-P20-TEAM-PACK-FILE-FLOW-ACCEPTANCE-2026-09-03.md)、[`V4.3-P21`](V4.3-P21-TEAM-PACK-RECIPE-EDITOR-ACCEPTANCE-2026-09-03.md)、[`V4.3-P31`](V4.3-P31-TEAM-PACK-GALLERY-CONSISTENCY-ACCEPTANCE-2026-09-03.md)。 |
| §3 / P0 Channels | New/Edit、kind/instructions/workspace/playbook、unread/last activity 的 service/UI/IPC 路径已证实，New/Edit roundtrip 有真实本地 gate；archive/restore/template/quick-switch 尚缺同等级独立 UI click-path 证据，详见第 3 节。 | [`V4.3-P19`](V4.3-P19-PRODUCT-BURST-AUDIT-CHANNEL-EDITOR-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/team-service.js`、`desktop/ui/product-hubs-ui.js`。 |
| §3 / P0 External Control | 已证实本地边界：bounded 14-operation legacy loopback + paired direct/opaque relay facade、scope/team/project binding、replay/tamper/downgrade/revoke/capacity denial、public projections 和生产 startup attach。 | [`V4.3-P1`](V4.3-P1-EXTERNAL-CONTROL-PLANE-ACCEPTANCE-2026-09-02.md)、`desktop/src/main/index.js:542`、`desktop/src/main/external-team-control.js`、`src/remote-controller-contract.js`。真实远程设备/relay 仍见第 4 节。 |
| §4–§6 Coworker、Team、动态协作、ModelBinding | 已证实本地：durable Coworker/Team/Channel、owner routing、DM/@mention/reply、directed handoff、review、bounded parallel specialists、join/stop、stale lineage、每 Coworker 的 safe ModelBinding projection 和 no-downgrade 规则。 | [`V4.3-P13`](V4.3-P13-DESKTOP-DIRECTED-COLLABORATION-ACCEPTANCE-2026-09-02.md)、[`V4.3-P14`](V4.3-P14-DESKTOP-PARALLEL-SPECIALISTS-ACCEPTANCE-2026-09-02.md)、[`V4.3-P16`](V4.3-P16-DESKTOP-TEAM-ACTIVITY-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/team-service.js`、`src/orchestrator.js`。真实 Provider useful work 不在本地证明范围。 |
| §11–§12 Memory、Projects/Workspace | 已证实本地：Coworker/Team/Project scope、source trace、edit/delete/forget/pin、relevance/index、Project switcher/create/archive/restore/export/backup、bounded command center、restart persistence 和 unavailable fail-closed。 | [`V4.3-P25`](V4.3-P25-MEMORY-EDITOR-ACCEPTANCE-2026-09-03.md)、[`V4.3-P34`](V4.3-P34-PROJECTS-EXPORT-ACCEPTANCE-2026-09-03.md)、[`V4.3-P40`](V4.3-P40-MEMORY-RELEVANCE-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/memory-service.js`、`desktop/src/main/project-service.js`。 |
| §13–§15 This PC、Computer abstraction、Worker Node | 已证实本地：This PC safe status/frame/history/takeover/hand-back；统一 target controller；loopback Worker Node health/action/job/routine/trigger/team path、idempotency、cancel、capacity、no-local-fallback。 | [`V4.3-P35`](V4.3-P35-THIS-PC-DEEP-LINKS-ACCEPTANCE-2026-09-03.md)、[`V4.2-P4 Worker Computer`](V4.2-P4-WORKER-COMPUTER-ACCEPTANCE-2026-09-02.md)、`desktop/src/main/computer-target-controller.js`、`desktop/src/main/worker-node-store.js`。LocalIsolated 的当前环境复现证据另列第 3 节。 |
| §17 Connected Apps / §18 bounded Apps Catalog | 已证实本地 bounded catalog：This PC/workspace first-party apps、search/filter、review-before-connect、cost/approval、Team/Coworker/Project assignment、connect/disconnect/disable、restart 和 safe health projection。 | [`V4.2-P7.2 Apps Catalog`](V4.2-P7.2-DESKTOP-APPS-CATALOG-ACCEPTANCE-2026-09-02.md)、[`V4.3-P32`](V4.3-P32-APPS-CATALOG-ACCEPTANCE-2026-09-03.md)、`desktop/src/main/connected-apps.js`。广泛 third-party marketplace 不属于已证实范围，见第 3 节。 |
| §19–§22 Skills、Playbooks、Routines、Event Triggers | 已证实本地：Skill execution 重新走 Coworker+Governor；Playbook declarative semantics；one-time/daily/weekly/custom durable scheduling、history/retry、Skill/Team Routine；workspace file trigger、debounce/storm guard、normal governed Job。 | [`V4.2-P3`](V4.2-P3-SKILLS-PLAYBOOKS-ROUTINES-ACCEPTANCE-2026-09-02.md)、[`V4.3-P46`](V4.3-P46-TRIGGER-WORKSPACE-LABEL-ACCEPTANCE-2026-09-03.md)、[`V4.3-P47`](V4.3-P47-ROUTINE-LIFECYCLE-ACCEPTANCE-2026-09-03.md)、[`verify-p51-routine-history.json`](verify-p51-routine-history.json)。 |
| §23–§24 Artifacts、Search、Command Palette | 已证实本地：canonical ArtifactStore、bounded indexes、full retained Conversation search、safe snippets/match reasons、8 search types、7 fixed palette actions、exact deep links、pagination/restart/invalidation。 | [`V4.3-P33`](V4.3-P33-SEARCH-PALETTE-ACCEPTANCE-2026-09-03.md)、[`V4.3-P39`](V4.3-P39-CONVERSATION-PAGINATION-ACCEPTANCE-2026-09-03.md)、[`V4.3-P44`](V4.3-P44-CONVERSATION-SEARCH-ACCEPTANCE-2026-09-03.md)、[`V4.3-P45`](V4.3-P45-ARTIFACT-CONTENT-SEARCH-ACCEPTANCE-2026-09-03.md)。 |
| §25 Attention / §33 Notifications | 已证实本地：Attention/approval/secret/takeover/failure paths、local allowlisted categories、dedupe、preferences、channel-unread trusted producer、bounded public projections 和 stale refresh guards。 | [`V4.3-P8`](V4.3-P8-ATTENTION-APPROVAL-ACCEPTANCE-2026-09-02.md)、[`V4.3-P17`](V4.3-P17-DESKTOP-NOTIFICATION-CENTER-ACCEPTANCE-2026-09-03.md)、[`V4.3-P18`](V4.3-P18-CHANNEL-UNREAD-NOTIFICATIONS-ACCEPTANCE-2026-09-03.md)。 |
| §34 Reliability / §35 Performance & Scale | 已证实本地：migration transaction、backup/restore/export/reset、restart/idempotency/rollback/stale-lineage、50+ roster bounded disclosure、300-message renderer window、Artifact/Search indexing、no session explosion。 | [`V4.2-P6`](V4.2-P6-RELIABILITY-DATA-LIFECYCLE-ACCEPTANCE-2026-09-02.md)、[`V4.3-P39`](V4.3-P39-CONVERSATION-PAGINATION-ACCEPTANCE-2026-09-03.md)、[`V4.3-P41`](V4.3-P41-COWORKER-ROSTER-ACCEPTANCE-2026-09-03.md)、[`V4.3-P42`](V4.3-P42-ARTIFACT-INDEX-ACCEPTANCE-2026-09-03.md)、[`V4.3-P43`](V4.3-P43-SEARCH-INDEX-ACCEPTANCE-2026-09-03.md)。 |
| §36 Security / Governance、§37 Testing Policy | 已证实本地：Intelligence != Authority、Governor、fail-closed、single owner、task-bound Computer、secret channel、hash-chain audit、repeat guard、credential/ProviderAccount/workspace/browser isolation、import/external-control redaction；测试以真实路径、invariant 和 targeted regression 为主。 | `src/governor.js`、`src/policy.js`、`src/audit.js`、`src/worker-secure-transport.js`、当前 root/Desktop suites、各 acceptance artifact 的 `fixtureBoundary=LOCAL_FIXTURE` 和 `publishEligible=false`。 |
| §38 First-run / §39 Settings | 已证实本地：fresh isolated Welcome、Install/Create Coworker、honest disconnected provider states、normal/Advanced hierarchy、model/computer/apps/notifications/backup/update/voice controls。 | [`V4.3-P36`](V4.3-P36-FIRST-RUN-ONBOARDING-ACCEPTANCE-2026-09-03.md)、[`V4.3-P37`](V4.3-P37-SETTINGS-HIERARCHY-ACCEPTANCE-2026-09-03.md)、`desktop/ui/index.html`、`desktop/ui/app.js`。真实登录和设备权限另列第 4 节。 |
| §43 Fast-path、§44 Priority、§45 North Star | 已证实架构遵守复用现有 Governor/Job/Computer/Artifact/Notification/External Control primitives；交付顺序已覆盖 P0 Product Burst、P1 协作、P3 breadth、P4/P5 边界和 P6 本地可靠性机制，且产品体验仍以 Coworkers/Channels/Projects/Computer/Apps/Skills/Routines/Files/Attention 为中心。 | canonical plan 与当前 `handoff/HANDOFF.md`；P0/P1/P3/P4/P5/P6 acceptance 文档和当前源码入口。 |

## 3) 真正缺失或证据不足的本地要求

以下是本地产品层面的剩余项；它们不是第 4 节的账号/网络/签名/发布阻塞，也没有把历史 acceptance 的局部通过扩大解释成完成。

| 本地要求 | 缺口 | 权威文件/入口 | 最小真实验收 |
|---|---|---|---|
| 广泛 Apps Catalog / third-party connector lifecycle | 当前已完成的是 bounded first-party catalog；第三方 marketplace、connector versioning、OAuth lifecycle、权限 review 和更多可治理 capability 尚未实现。这是 canonical §18 的后续产品扩展，不影响当前 P0 bounded catalog。 | canonical §17–18；`desktop/src/main/connected-apps.js`；[`V4.2-P7.2`](V4.2-P7.2-DESKTOP-APPS-CATALOG-ACCEPTANCE-2026-09-02.md)。 | 以本地 reviewed manifest fixture 完成 connect/disconnect/disable、Team/Coworker/Project scope、restart、cost/approval 和 authority rejection 的真实 UI/IPC roundtrip；真实 OAuth 另按第 4 节验收。 |
| LocalIsolated 当前 HEAD 的可重复证据 | P5 设计和历史 Docker canary 已存在，但本次 desktop Node suite 的 LocalIsolated case 因当前环境缺 Docker/image 而 skip；因此“当前环境重新可重复”证据不足，不能把 skip 写成 pass。 | `desktop/test/p5-computer-targets-canary.test.mjs:38`；`desktop/src/main/local-isolated-computer.js`；[`V4.2-P5`](V4.2-P5-OPTIONAL-COMPUTER-TARGETS-ACCEPTANCE-2026-09-02.md)。 | 在具备既有 `ubuntu:24.04` image 的本地环境运行现有 P5 canary，真实验证 no-network container、relative read/write、traversal rejection、cleanup、lease/audit/Attention；不新增测试架构。 |
| Settings 的 Update Apply 产品对话框 | Update backend 的 channel/check/stage/apply/backup/rollback contract 已有；当前 renderer `ensureUpdateCard()` 仍使用 blocking `window.confirm`，且没有与 P48/P49/P50 同等级的当前 click-path cancel/no-write/failure gate。 | `desktop/ui/app.js:2736`；[`V4.2-P6.2`](V4.2-P6.2-RELEASE-UPDATE-LOCAL-RC-ACCEPTANCE-2026-09-02.md)；canonical §39–40。 | 用 in-product confirmation 覆盖 cancel、pending duplicate、apply failure、restart-required success，并通过既有 typed `updates.apply` 验证无额外 authority；不得把 update gate 拆成独立产品编号。 |
| Channels archive/restore/template/quick-switch UI evidence | 这些功能的 service/IPC/test 路径存在，当前真实 UI gate 只覆盖 Channels New/Edit；不能仅凭 DOM 代码或 service canary 宣称完整 P0 UI。 | [`V4.3-P19`](V4.3-P19-PRODUCT-BURST-AUDIT-CHANNEL-EDITOR-ACCEPTANCE-2026-09-03.md)；`desktop/ui/product-hubs-ui.js`；`desktop/test/team-service.test.mjs`。 | 在真实本地 renderer/preload/IPC 上分别点击 archive/restore、template create/use、quick-switch，验证 unread/last activity、scope、restart 和 stale/archived fail-closed；仅补最小 click-path，不新增 authority。 |
| Native Android controller package | 当前有 WebView/PWA-hostable `ui/controller.html` 和 secure contract，但没有 Android APK/native host。 | canonical §§28–29；[`V4.4-P1`](V4.4-P1-ANDROID-MOBILE-REMOTE-ACCESS-ACCEPTANCE-2026-09-02.md) 明确“不 claim APK”；`ui/controller.html`。 | 先完成 host-owned pairing/lease/cache boundary 的可构建 native package，再做设备 pairing；APK 签名和真实设备属于第 4 节外部验证。 |
| Cloud Computer runtime | 当前只有 opt-in/budget-gated profile 与 fail-closed target controller；没有实际 CloudComputer adapter/runtime。 | canonical §30；`desktop/src/main/computer-target-controller.js:60`；[`V4.2-P5`](V4.2-P5-OPTIONAL-COMPUTER-TARGETS-ACCEPTANCE-2026-09-02.md)。 | 只有在明确 provider、cost、budget 和 isolation 后，使用本地 fake service 先验证 estimate/reserve/settle/cancel/idempotency；真实云执行和费用不在当前边界。 |
| Voice Call / telephony | Desktop Web Speech push-to-talk 与 final-only speak reply 已证实；Voice Call/telephony adapter、呼叫生命周期尚未实现。 | canonical §31；[`V4.2-P7.1`](V4.2-P7.1-DESKTOP-VOICE-ACCEPTANCE-2026-09-02.md)。 | 实现独立 telephony adapter 后，以 fake call provider 验证 incoming/outgoing、cancel、consent、Attention、transcript redaction；真实电话网络另行授权。 |
| macOS/Linux Desktop | 业务层有平台中立边界，但没有 macOS/Linux native packaging、installer 和平台验收。 | canonical §32；当前 `desktop` Electron/Windows release scripts。 | 各平台完成 build/package、safe data path/Computer adapter、restart/recovery smoke；不把 Windows 本地证据外推为跨平台完成。 |

本节本地缺口数量：8 项（其中 3 项是当前 UI/环境证据不足，5 项是未完成的后续产品能力/UX）。P0 #118 中除 Channels 遗留 UI click-path 外的核心能力、P1 协作、当前 Windows-first P3 breadth、Worker/External Control 的本地 bounded contract 不在缺口清单中。

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

为避免无限扩张，后续本地工作上限为 7 个产品能力；不新增 P 编号，也不把 verifier/test script correction 拆成产品项：

1. Update Apply 产品对话框与 cancel/pending/failure/restart UX。
2. LocalIsolated 目标的当前环境可重复 smoke 证据。
3. Channels archive/restore/template/quick-switch UI product paths。
4. Third-party Apps Catalog 的 reviewed connector lifecycle。
5. Native Android Remote Controller package boundary。
6. Cloud Computer target adapter 与 Voice Call 独立产品能力。
7. macOS/Linux Desktop packaging 与平台 Computer adapter。

达到这份清单的本地证据要求，仍不会自动完成第 4 节的真实账号、网络、设备、签名或发布事项；那些必须由用户另行解除限制并单独验收。
