import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP23Skills } from "./verify-p23-skills.js";
registerAppSchemePrivileged(); app.setName("SovereignBot P23 Skill Verification"); app.enableSandbox(); app.setAppUserModelId("com.sovereignbot.desktop.verify-p23-skills");
app.whenReady().then(() => runVerifyP23Skills({ app })).catch((error) => { try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {} app.exit(1); });
