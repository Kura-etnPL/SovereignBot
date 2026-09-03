import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP39ConversationPagination } from "./verify-p39-conversation-pagination.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P39 Conversation Pagination Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p39-conversation-pagination");
app.whenReady().then(() => runVerifyP39ConversationPagination({ app })).catch((error) => { try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {} app.exit(1); });
