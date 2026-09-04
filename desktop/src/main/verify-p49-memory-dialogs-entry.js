import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP49MemoryDialogs } from "./verify-p49-memory-dialogs.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P49 Memory Dialog Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p49-memory-dialogs");
app.whenReady().then(() => runVerifyP49MemoryDialogs({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
