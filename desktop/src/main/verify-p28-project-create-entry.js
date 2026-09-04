import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP15ProjectCommandCenter } from "./verify-p15-project-command-center.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P28 Project Create Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p28-project-create");
app.whenReady().then(() => runVerifyP15ProjectCommandCenter({ app, projectCreateGate: true })).catch((error) => { try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {} app.exit(1); });
