import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyUpdateApplyDialog } from "./verify-update-apply-dialog.js";

registerAppSchemePrivileged();
app.setName("SovereignBot Update Apply Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-update-apply-dialog");
app.whenReady().then(() => runVerifyUpdateApplyDialog({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
