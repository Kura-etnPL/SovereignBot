import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyV44EventTriggers } from "./verify-v44-event-triggers.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-v44-event-triggers");

app.whenReady().then(async () => {
  try {
    await runVerifyV44EventTriggers({ app });
  } catch (error) {
    try { process.stderr.write(`[verify-v44] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
