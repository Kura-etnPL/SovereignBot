import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP14TeamFanout } from "./verify-p14-team-fanout.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P14 Parallel Specialists Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p14-team-fanout");

app.whenReady().then(async () => {
    try { await runVerifyP14TeamFanout({ app }); }
    catch (error) { try { process.stderr.write(`[verify-p14] ${String(error?.stack ?? error)}\n`); } catch {} app.exit(1); }
});
