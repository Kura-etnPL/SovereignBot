import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP16TeamActivity } from "./verify-p16-team-activity.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p16-team-activity");
app.whenReady().then(() => runVerifyP16TeamActivity({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
