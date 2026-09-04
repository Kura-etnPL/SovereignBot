import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP45ArtifactSearch } from "./verify-p45-artifact-search.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p45-artifact-search");
app.whenReady().then(() => runVerifyP45ArtifactSearch({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
