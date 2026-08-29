import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyV43Attention } from "./verify-v43-attention.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-v43-attention");

app.whenReady().then(async () => {
  try {
    await runVerifyV43Attention({ app });
  } catch (error) {
    try { process.stderr.write(`[verify-v43] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
