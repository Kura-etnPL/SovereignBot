import { app } from "electron";
import { registerAppSchemePrivileged } from "./protocol.js";
import { runVerifyV46ProjectMemorySearch } from "./verify-v46-project-memory-search.js";

registerAppSchemePrivileged();
app.enableSandbox();
app.setAppUserModelId(process.env.SOVEREIGNBOT_MEMORY_EDITOR_EVIDENCE_DIR ? "com.sovereignbot.desktop.verify-p25-memory-editor" : "com.sovereignbot.desktop.verify-v46-project-memory-search");

app.whenReady().then(async () => {
  try {
    await runVerifyV46ProjectMemorySearch({ app });
  } catch (error) {
    try { process.stderr.write(`[verify-v46] ${String(error?.stack ?? error)}\n`); } catch {}
    app.exit(1);
  }
});
