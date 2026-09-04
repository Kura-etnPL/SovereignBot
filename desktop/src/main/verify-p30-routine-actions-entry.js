import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyRoutines } from "./verify-routines.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p30-routine-actions");

app.whenReady().then(async () => {
  try {
    await runVerifyRoutines({ app, routineActionsGate: true });
  } catch (error) {
    try { process.stderr.write(`[verify-p30] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
