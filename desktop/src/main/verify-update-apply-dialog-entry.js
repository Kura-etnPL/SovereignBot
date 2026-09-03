import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyUpdateApplyDialog } from "./verify-update-apply-dialog.js";

registerAppSchemePrivileged();
app.setName("SovereignBot Update Apply Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-update-apply-dialog");
let gateFinished = false;
app.on("window-all-closed", (event) => {
  if (!gateFinished) event.preventDefault();
});
app.whenReady().then(async () => {
  try {
    await runVerifyUpdateApplyDialog({ app });
    gateFinished = true;
    app.exit(0);
  } catch (error) {
    gateFinished = true;
    try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
    app.exit(1);
  }
});
