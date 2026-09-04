import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP51RoutineHistory } from "./verify-p51-routine-history.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p51-routine-history");

app.whenReady().then(async () => {
  try {
    await runVerifyP51RoutineHistory({ app });
  } catch (error) {
    try { process.stderr.write(`[verify-p51] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
