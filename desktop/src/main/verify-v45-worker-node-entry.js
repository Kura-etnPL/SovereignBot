import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyV45WorkerNode } from "./verify-v45-worker-node.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-v45-worker-node");
// The gate destroys its only BrowserWindow before writing the final redacted
// evidence. Keep Electron alive until that async cleanup completes; the gate
// explicitly exits after the evidence write and never changes product runtime
// window behavior.
app.on("window-all-closed", (event) => event.preventDefault());

app.whenReady().then(async () => {
  try {
    await runVerifyV45WorkerNode({ app });
  } catch (error) {
    try { process.stderr.write(`[verify-v45] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
