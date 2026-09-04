import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP50JobActions } from "./verify-p50-job-actions.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P50 Work Job Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p50-job-actions");
app.whenReady().then(() => runVerifyP50JobActions({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
