// Production driver connectivity only: no prompts, credential copying or login.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFirstRunService } from "../src/main/first-run.js";
import { SidecarComputerDriver } from "../../src/sidecar-computer-driver.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(join(project, "temp"), { recursive: true });
const dataDir = mkdtempSync(join(project, "temp", "chatgpt-connection-"));
const firstRun = createFirstRunService({ host: { dataDir }, services: {} });
let driver;
const evidence = { schema: "sovereignbot.chatgpt-connection.v1", sentPrompts: 0, profile: "new-isolated", dataDir };
try {
    const installed = await firstRun.provisionManagedBrowserDriver();
    evidence.provisioning = installed;
    if (!installed.ok || !installed.digestVerified) throw new Error("No integrity-verified browser driver is available");
    const record = firstRun.driverRecord();
    const profileDir = join(dataDir, "profile");
    driver = new SidecarComputerDriver({ agentId: "chatgpt-connection-check", profileDir, workspaceDir: dataDir }, {
        browser: "chrome", headless: true,
        webdriverCommand: join(dataDir, "desktop-state", record.cacheDirRelative, record.exe),
    });
    await driver.navigate("https://chatgpt.com/");
    const page = await driver.chatGPTPage();
    evidence.page = { authenticated: page.authenticated, chatMode: page.chatMode, challenge: page.challenge, availableModels: page.availableModels };
    evidence.status = page.challenge ? "human-verification-required" : !page.authenticated ? "sign-in-required" : "connected-unverified-model";
} catch (error) {
    evidence.status = "unavailable";
    evidence.error = String(error.message).slice(0, 1000);
    process.exitCode = 1;
} finally {
    await driver?.close();
    writeFileSync(join(dataDir, "connection-result.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
}
