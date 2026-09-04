import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP24Artifacts } from "./verify-p24-artifacts.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P24 Artifact Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p24-artifacts");
app.whenReady().then(() => runVerifyP24Artifacts({ app })).catch((error) => { try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {} app.exit(1); });
