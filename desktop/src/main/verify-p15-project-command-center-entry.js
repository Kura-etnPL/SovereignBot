import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP15ProjectCommandCenter } from "./verify-p15-project-command-center.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p15-project-command-center");
app.whenReady().then(() => runVerifyP15ProjectCommandCenter({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
