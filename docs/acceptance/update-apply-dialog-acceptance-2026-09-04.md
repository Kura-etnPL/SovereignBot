# Settings Update Apply 产品验收

日期：2026-09-04。此能力只验证本地 Settings 产品入口、renderer dialog、sandboxed preload 和 typed `update:apply` IPC；不运行 Setup.exe，不安装/升级真实用户环境，不访问网络、账号、Provider 或发布系统。

## 交付范围

- `ensureUpdateCard()` 不再调用 blocking `window.confirm`，Apply-on-restart 改为产品内 `<dialog>`。
- Cancel/关闭只关闭 dialog，不调用 `updates.apply`，因此不产生写入或重启请求。
- Apply 期间用单一 pending guard 抑制重复提交，并锁定相关更新控件。
- apply failure 在 dialog 内显示安全、可读错误，保留 dialog 和重试入口；不把临时目录、session、provider 或 credential 细节暴露给 renderer。
- 成功后关闭 dialog，并在 Settings 状态中明确显示版本和 restart required。
- 复用现有 `window.sovereignbot.updates.apply({})`、P6 update service 和既有 authority boundary；没有创建第二 update engine 或新增 IPC 权限。

## 本地证据

- 静态 targeted regression：`npm test -- --test-name-pattern="Update Apply"`。
- 隐藏 Electron gate：`npm run verify:update-apply-dialog`。
- Gate artifact：`docs/acceptance/verify-update-apply-dialog.json`，应为 `fixtureBoundary=LOCAL_FIXTURE`、`publishEligible=false`、`ok=true`；本次不预造未运行 gate 的证据文件。

External actions：[]。Setup.exe、签名、真实 Provider、网络、账号、设备和发布验收仍按本地产品总审计的外部暂缓范围执行。
