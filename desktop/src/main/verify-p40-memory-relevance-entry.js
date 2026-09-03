import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyP40MemoryRelevance } from "./verify-p40-memory-relevance.js";

registerAppSchemePrivileged();
app.setName("SovereignBot P40 Memory Relevance Verification");
app.enableSandbox();
app.setAppUserModelId("com.sovereignbot.desktop.verify-p40-memory-relevance");
app.whenReady().then(() => runVerifyP40MemoryRelevance({ app })).catch((error) => {
  try { process.stderr.write(String(error?.stack ?? error) + "\n"); } catch {}
  app.exit(1);
});
