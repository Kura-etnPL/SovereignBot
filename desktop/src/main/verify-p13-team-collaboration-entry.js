import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP13TeamCollaboration } from "./verify-p13-team-collaboration.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P13 Team Collaboration Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p13-team-collaboration");

app.whenReady().then(async () => {
    try { await runVerifyP13TeamCollaboration({ app }); }
    catch (error) { try { process.stderr.write(`[verify-p13] ${String(error?.stack ?? error)}\n`); } catch {} app.exit(1); }
});
