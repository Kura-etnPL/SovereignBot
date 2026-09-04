# Channels 产品路径验收

日期：2026-09-04。此能力只验证本地 Channels 页面、主会话详情中的现有 Channels 控件、sandboxed preload、typed IPC、TeamService 和 ConversationStore；不访问网络、账号、Provider、Cloudflare、GitHub、Setup.exe 或真实用户数据。

## 交付范围

- 复用现有 Channels 页面和详情面板，不创建第二套 channel/store/router。
- 通过产品页面选择 Team 与 Channel Template，点击 From template 创建真实 Channel。
- 通过 Quick switch 选择并打开 Channel，验证 unread 与 latest activity 的安全投影。
- 通过产品卡片点击 Archive，在 Archived/includeArchived 视图看到只读 Channel，再点击 Restore 恢复。
- 通过同一 typed IPC 边界验证 archived channel 写入和 stale channel 操作 fail closed。
- 通过 service/renderer 重建验证 archived 状态持久化；页面可见文本不暴露 raw path、session、provider 或 opaque internal IDs。
- 现有控件与 handler 已存在，本次没有新增 authority 或另起产品实现。

## 本地证据

- 静态 targeted regression：`npm test -- --test-name-pattern="Channels product"`。
- 隐藏 Electron gate：`npm run verify:channels-product-path`。
- Gate artifact：`docs/acceptance/verify-channels-product-path.json`，应为 `fixtureBoundary=LOCAL_FIXTURE`、`publishEligible=false`、`ok=true`；本次不预造未运行 gate 的证据文件。

External actions：[]。真实多机 pairing、Android/native host、Provider、网络、签名、安装和发布验收仍按本地产品总审计的 external deferred 范围执行。
