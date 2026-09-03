import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP33SearchPalette } from "./verify-p33-search-palette.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p33-search-palette");
app.whenReady().then(() => runVerifyP33SearchPalette({ app })).catch((error) => { console.error(error?.stack ?? error); app.exit(1); });
