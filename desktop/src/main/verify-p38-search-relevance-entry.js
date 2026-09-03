import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP38SearchRelevance } from "./verify-p38-search-relevance.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P38 Search Relevance Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p38-search-relevance");
app.whenReady().then(() => runVerifyP38SearchRelevance({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
