import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyChannelsProductPath } from "./verify-channels-product-path.js";

registerAppSchemePrivileged();
app.setName("SovereignBot Channels Product Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-channels-product-path");
let gateFinished = false;
app.on("window-all-closed", (event) => {
  if (!gateFinished) event.preventDefault();
});
app.whenReady().then(async () => {
  try {
    await runVerifyChannelsProductPath({ app });
    gateFinished = true;
    app.exit(0);
  } catch (error) {
    gateFinished = true;
    try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
    app.exit(1);
  }
});
