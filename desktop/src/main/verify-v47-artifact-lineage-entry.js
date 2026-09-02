import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyV47ArtifactLineage } from "./verify-v47-artifact-lineage.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P10 Artifact Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-v47-artifact-lineage");

app.whenReady().then(async () => {
  try {
    await runVerifyV47ArtifactLineage({ app });
  }
  catch (error) {
    try { process.stderr.write(`[verify-v47] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
