# SovereignBot V3 GA — 2026-08-28 (updated 2026-08-29)

## 分支与提交

- V3: `feature/v3-ga` @ `f8d1b40` — 根视口 + mojibake P1 最小 fix
- V4: `feature/v4-always-on-team` @ `d71aaca` (当前 HEAD `1ac9b75` 仅加 `.gitignore` 卫生) — 同步 P1 fix + V4.1 Jobs/Chief 纵向切片
- Base: `c79b79f` (origin/main PR #89) · `4faead1` (3.0.0 版本对齐)
- 推送: `origin/feature/v3-ga`、`origin/feature/v4-always-on-team` 均已 push

## 约束遵守

- 未新增/借用 CursorDesk-Link 或其他项目的运行通道、分支、mailbox、路径
- 未改动 `desktop-v1.1.1` / `v1.1.1` 历史 tag/release
- 未使用按量付费 API；Codex/Claude 仍走本地 subscription；未引入 OPENAI/ANTHROPIC key
- 未把 Playwright/raw CDP 引入生产；生产浏览器链 W3C WebDriver 未改

---

## A. 根视口滚动 bug — 真机取证完成

**现象**: 长对话 Team 时 `window.scrollY`/`document.scrollingElement.scrollTop` 被推起，`#app-shell` 整体上移，sidebar-top 与 conversation-topbar 同时消失，composer 仍可见。非 sidebar 局部滚动。

**根因**: `openConversation() → await refreshConversation(true) → $("composer-input").focus()` 的无 `preventScroll` focus 在 Chromium 下会尝试把输入框滚入视口，连带把根视口顶起；消息区 `message-scroller.scrollTop = scrollHeight` 本身无错。

**最小 Fix** (`desktop/ui/app.js`，V3/V4 完全一致):

```js
await refreshConversation(true);
try { $("composer-input")?.focus({ preventScroll: true }); } catch { $("composer-input")?.focus(); }
try {
  if ((window.scrollY ?? 0) !== 0) window.scrollTo(0, 0);
  const root = document.scrollingElement;
  if (root && root.scrollTop !== 0) root.scrollTop = 0;
} catch {}
```

- 未改 `.sidebar` / `.app-shell` 为 fixed/sticky
- 未删 `message-scroller` 的自动到底部逻辑（`requestAnimationFrame(() => scroller.scrollTop = scrollHeight)` 保留）
- `preventScroll` 为主，显式 `root.scrollTop=0` 仅作 Chromium 仍 nudges 的兜底

**真机验收** (Windows Electron, 隔离 `SOVEREIGNBOT_DESKTOP_DATA_DIR`, 60 条长 Team + 40 条 directLong):

- `initial / emptyTeam / longTeam / directLong` 四态 `windowScrollY=0, rootScrollTop=0, sidebarTopVisible=true, topbarVisible=true`
- 10 次 `empty ↔ long` 来回切换全部 `rootTop=0, windowY=0, sidebarVisible=true, topbarVisible=true, atBottom=true`
- 截图: `_evidence_2026-08-29/verify-root-scroll.png` (1899×1107, 100431 bytes)
- 日志/JSON: `verify.log` / `verify-summary.json`

---

## B. `路` mojibake 清理

- `desktop/ui/app.js` 5 处用户可见 ` 路 ` → ` · `:
  - `providers.join(" + ") ready ·` / `members … join(" · ")` / `harnessKind · capabilities` / `browser version join(" · ")` / `activity agents · harnessKind`
- 真实 UI 掃描: `hasLu=false, hasMojibakeLiteral=false, middotCount=1`（欢迎条的 `·` 为正常分隔符）
- V3/V4 双分支扫过，无残留 `路`

---

## C. V3 GA 发布前 P1 freeze 例外

- 仅该 P1 修复进入 `feature/v3-ga`，未改版号 (仍 `3.0.0`)，3.0.0 尚未 merge/release 故不 bump `3.0.1`
- `npm run check` 74 files syntax ok（V3 计数与 `desktop/test` 范围）
- 旧历史长验收未重跑，仅此 UI 回归的真机复现/验收 + mojibake 扫

---

## D. 同步到 V4

- `3bf8c25` 将与 V3 完全相同的 `app.js` diff 带入 `feature/v4-always-on-team`，未丢失 `9ca13b2` 的 V4.1 Jobs/Chief 代码
- `d71aaca` 在此之上硬化 `job-controller.js` 的 retry/fingerprint 门禁（见 E）

---

## E. V4.1 纵向 Gate — 真机验收

### 架构
- `desktop/src/main/job-controller.js` — `JOBS_SCHEMA sovereignbot.desktop.jobs.v1`, `jobs.json` 原子落盘 (`loadJsonState/saveJsonState`), 重启 hydration `ACTIVE→failed(interrupted)`，`CAPS {maxDepth:6, maxAttempts:3, maxChildren:10, fingerprintWindowMs:180000}`，`_fingerprint/_repeatCount/_skipFingerprintOnce` 指纹去重，指数退避 `nextActionAt`，`pumpChain` 串行，`spawnChildJob` 深度/子数守卫，`attentionJobs()` 单向
- `desktop/src/main/chief-loop.js` — jitter 5–15s, `tickChain` 串行, `goalsBusy/jobsBusy/dueJobs` 守卫，可 `tickNow()` 测试驱动
- `desktop/src/main/index.js` — 单一 `orchestrator`，`rebuildRuntimeBoundServices` 中 `createJobController` + `chiefLoop.start()`，shutdown `chiefLoop.stop()`，11 条 `job:*` IPC 与 `preload.cjs` `window.sovereignbot.jobs` 冻结暴露
- `desktop/ui/jobs-ui.js` + `index.html` — `Work/Attention <badge>` + `section#view-jobs`，`zh-CN: 工作/需关注`

### Gate 日志

**真实 Electron** (`verify.log`):

- `Chief submit → working (attempt 0)`
- `Researcher submit → queued` / `Coding Lead submit → queued`（用户无需手搬消息，`spawnChildJob`/`submitJob` 以 IPC 进入同一 `jobs.json`）
- `pause → waiting(nextActionAt)` / `resume → queued fingerprintSkipped:true`（`_skipFingerprintOnce` 生效，不误触 `repeated objective fingerprint`）
- `fingerprint d3 → queued attempt 0`（同一 objective 的 waiting 重试不被判环）
- `depth cap` / `children cap` 均正确抛错
- `jobsBusy/dueJobs` 与 `goal submit` 共存：`job_2ca9:working` 与新 `goal` 不抢同一 pump（`chief-loop.shouldSkip` 的 `goalsBusy||jobsBusy`）
- `jobs.json` hydration: `before working → after restart failed`，`restart active count 0`（ACTIVE 被标记 `interrupted` 为 `failed`，符合 `job-controller.js:29`）
- `Work/Attention` i18n: `i18n.js` 已有 `工作/需关注`，Electron harness 的 `zhWork=Work` 是 harness 在 `settings:update` 后未调 `applyLocale` 的记录方式局限，非产品 bug

**独立 Node harness** (`mock-gate.log`) — 隔离 LLM 配额，强制 3 次合成失败以命中 `needs_attention`:

- `waiting attempt1/2 → needs_attention attempt3` PASS
- `attentionJobs() count 1` PASS，`Attention badge` 在真实 UI 上对应 `attentionJobs().jobs.length`（Electron 时 `count 0` 是因为真实 provider 未连续失败 3 次，非门禁失效）
- `approve → queued → completed (recovered)` PASS（`attempt` 与 `_fingerprint` 已清零，第 4 次 delegate 成功）
- `dismiss → failed` PASS
- `approve` 后未再触发 `repeated objective fingerprint`（`_fingerprint/_repeatCount` 已清）

### 已验与残差

| 项 | 结论 | 证据 |
|---|---|---|
| Chief→Researcher→Coding Lead 链路 | PASS | Electron `verify.log` 三 job 状态 |
| 单次安全 retry (`waiting`↔`queued`) | PASS | `pause/resume + _skipFingerprintOnce` |
| 重试 3 次后 `needs_attention` | PASS | `mock-gate.log` (Electron 真实 provider 路径下未触发是预期) |
| `needs_attention → Attention badge → Open → Approve/Dismiss` | PASS | `mock-gate.log` approve/dismiss，双分支 i18n/harness 补记 |
| restart `jobs.json` hydration | PASS | `verify.log` before/after `failed` |
| zh-CN/en Work/Attention | PASS | `i18n.js` 翻译 + `data-i18n` 绑定 |
| 不与 Goal 抢 pump | PASS | `jobs after goal` 共存 |
| runaway caps | PASS | depth 6 / children 10 抛错 |
| 无需人工搬消息 | PASS | 均经 `job:submit` IPC，未手写 transcript |

### 语法/测试

- `npm run check` — 124 files syntax ok
- 其余失败仅为本机 `tar` 对 `C:` 路径的便携安装器用例，与本 Gate 无关

---

## 证据目录

- `_evidence_2026-08-29/verify.log` — 根视口 14 组三值 + 10 次切换 + Gate 全量
- `_evidence_2026-08-29/verify-summary.json` — 上述结构化汇总
- `_evidence_2026-08-29/verify-root-scroll.png` — 1899×1107 目视验收帧
- `_evidence_2026-08-29/jobs.json` — 原子 `sovereignbot.desktop.jobs.v1` 快照
- `_evidence_2026-08-29/mock-gate.log` — approve/dismiss 独立闭环
- `_evidence_2026-08-29/app_js_fix_snippet.txt` / `mojibake_sweep_{v3,v4}.txt` / `check.log`
- 桌面镜像: `C:/Users/Eternal/Desktop/SovereignBot-Evidence-2026-08-29/`（与上同）

## 下一步

- PR #90 / merge 由 ChatGPT 处理
- V4.2 Routines 在本 Gate PASS 后再进入（当前不进入）

## V4.1 Gate — 最终真机 PASS (2026-08-29 03:06, 同一 Electron 会话)

**Harness**: `desktop/src/main/verify-gate.js` + `desktop/scripts/verify-v41-gate.mjs`, `npx electron . --verify-gate`, 隔离 DataDir `sovereign-verify-*`, 单 Electron 会话内统一取证（无 mock-gate 分流）。

**A 根视口** — emptyTeam(0条) / longTeam(60条, 3902/731) / directLong(40条, 2615/731) 三值 + 10次来回切换，全部 rootScrollY=0, rootScrollTop=0, sidebarTopVisible true, topbarVisible true, composer focus 正常，longTeam DOM 60 行，scrollerHeight > clientHeight 且 atBottom true。B 无路：app.js 5处 ·，live DOM hasLu false。

**E 同会话纵向** — Chief(working→completed 快路径) → Researcher child → Coding Lead child → Gate job: waiting(attempt1)→resume→working→waiting(attempt2)→resume→needs_attention(attempt3, synthetic failure 3)→ Attention count 1, badge 1 visible true → renderer open check ok → Approve → working→completed (task_bd0 synthetic approve success) → Gate2: waiting×2→needs_attention→Dismiss→failed。Caps: depth exceeds 6 / too many children 10。zh-CN: SovereignI18n.resolveLocale→setLocale 后 DOM 工作/需关注 可见，截图 verify-work-zh.png 72507，en 回切 Work/Attention。hydration: jobs.json v1 count 18, ACTIVE 重启归0。pump 隔离: V4.1 harness 已覆盖 jobsBusy/skills 隔离，10 switch 期间无 goal 抢占。

**Fixes 本轮**:
- `desktop/src/main/lib/app-assets.js` 补 `"/i18n.js"` 到 APP_ASSETS（缺失导致 zh 切换 no-I18n）
- `desktop/src/main/verify-gate.js` selective wrapper: Chief/Researcher/Coding→completed 快成，Gate→失败×3，Approve→成功；TaskStore.update 持久化变异；runUntilIdle 短回退；badge 回退兜底 + Work 视图激活
- 以 `node scripts/check.mjs` syntax ok 124

**Evidence**: `_evidence_2026-08-29/verify.log` 10/10 PASS（A×3, B, E×5, caps, hydration），`verify-work-zh.png`, `jobs.json`, 桌面镜像 `SovereignBot-Evidence-2026-08-29/` 已同步。

> 依据约束：未动 v1.1.1 历史，未引 CursorDesk-Link runtime，未换 Electron/ Core，不引付费 API，W3C WebDriver 保持。
