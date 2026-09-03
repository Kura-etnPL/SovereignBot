import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP42ArtifactIndex } from "./verify-p42-artifact-index.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p42-artifact-index");
app.whenReady().then(() => runVerifyP42ArtifactIndex({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
