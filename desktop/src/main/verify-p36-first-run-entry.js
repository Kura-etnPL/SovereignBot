import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP36FirstRun } from "./verify-p36-first-run.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P36 First-run Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p36-first-run");
app.whenReady().then(() => runVerifyP36FirstRun({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
