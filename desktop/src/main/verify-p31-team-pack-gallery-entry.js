import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP31TeamPackGallery } from "./verify-p31-team-pack-gallery.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P31 Team Pack Gallery Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p31-team-pack-gallery");

app.whenReady().then(async () => {
  try {
    await runVerifyP31TeamPackGallery({ app });
  }
  catch (error) {
    try { process.stderr.write(`[verify-p31] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
