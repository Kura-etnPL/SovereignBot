import { app } from "electron";
import { runVerifyP44ConversationSearch } from "./verify-p44-conversation-search.js";

app.whenReady().then(() => runVerifyP44ConversationSearch({ app })).catch((error) => { console.error(error); app.exit(1); });
