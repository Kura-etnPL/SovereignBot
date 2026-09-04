import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP22Playbooks } from "./verify-p22-playbooks.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P22 Playbook Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p22-playbooks");

app.whenReady().then(() => runVerifyP22Playbooks({ app })).catch((error) => {
    try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
    app.exit(1);
});
