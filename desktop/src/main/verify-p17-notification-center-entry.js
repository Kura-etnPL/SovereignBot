import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP17NotificationCenter } from "./verify-p17-notification-center.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p17-notification-center");
app.whenReady().then(() => runVerifyP17NotificationCenter({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
