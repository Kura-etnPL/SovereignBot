import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP41CoworkerRoster } from "./verify-p41-coworker-roster.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p41-coworker-roster");
app.whenReady().then(() => runVerifyP41CoworkerRoster({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
