import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP11TeamPacks } from "./verify-p11-team-packs.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P11 Team Pack Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p11-team-packs");

app.whenReady().then(async () => {
  try {
    await runVerifyP11TeamPacks({ app });
  }
  catch (error) {
    try { process.stderr.write(`[verify-p11] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
