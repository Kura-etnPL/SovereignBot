import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP15ProjectCommandCenter } from "./verify-p15-project-command-center.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P29 Routine Selector Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p29-routine-selector");
app.whenReady().then(() => runVerifyP15ProjectCommandCenter({ app, routinePaletteGate: true })).catch((error) => { try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {} app.exit(1); });
