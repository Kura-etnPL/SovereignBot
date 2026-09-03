import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyChannelsProductPath } from "./verify-channels-product-path.js";

registerAppSchemePrivileged();
app.setName("SovereignBot Channels Product Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-channels-product-path");
app.whenReady().then(() => runVerifyChannelsProductPath({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
