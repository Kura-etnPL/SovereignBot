import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyRoutines } from "./verify-routines.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-routines");

app.whenReady().then(async () => {
  try {
    await runVerifyRoutines({ app });
  } catch (error) {
    try { process.stderr.write(`[verify-v42] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
