import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP32AppsCatalog } from "./verify-p32-apps-catalog.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p32-apps-catalog");
app.whenReady().then(() => runVerifyP32AppsCatalog({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
