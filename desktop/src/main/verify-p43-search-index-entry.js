import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP43SearchIndex } from "./verify-p43-search-index.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p43-search-index");
app.whenReady().then(() => runVerifyP43SearchIndex({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
