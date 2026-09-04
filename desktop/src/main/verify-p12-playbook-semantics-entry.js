import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP12PlaybookSemantics } from "./verify-p12-playbook-semantics.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P12 Playbook Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p12-playbook-semantics");

app.whenReady().then(async () => {
    try { await runVerifyP12PlaybookSemantics({ app }); }
    catch (error) { try { process.stderr.write(`[verify-p12] ${String(error?.stack ?? error)}\n`); } catch {} app.exit(1); }
});
