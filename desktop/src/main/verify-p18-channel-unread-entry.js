import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP18ChannelUnread } from "./verify-p18-channel-unread.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p18-channel-unread");
app.whenReady().then(() => runVerifyP18ChannelUnread({ app })).catch((error) => {
    console.error(error?.stack ?? error);
    app.exit(1);
});
