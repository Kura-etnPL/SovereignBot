import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP37Settings } from "./verify-p37-settings.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P37 Settings Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p37-settings");
app.whenReady().then(() => runVerifyP37Settings({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
