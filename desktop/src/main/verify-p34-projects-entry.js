import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP34Projects } from "./verify-p34-projects.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p34-projects");
app.whenReady().then(() => runVerifyP34Projects({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
