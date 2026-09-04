import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP48DataLifecycle } from "./verify-p48-data-lifecycle.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P48 Data Lifecycle Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p48-data-lifecycle");
app.whenReady().then(() => runVerifyP48DataLifecycle({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
