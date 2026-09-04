import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_EVIDENCE_DIR = join(process.cwd(), "..", "..", "..", "runtime", "sovereign-control", "live-codex-dogfood", "evidence");

export async function runLiveCodexDogfood({
    win,
    dataDir,
    getHost,
    getServices,
    getCoworkerStore,
    getConversationStore,
    getTeamService,
    getArtifactStore,
    evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR,
} = {}) {
    await mkdir(evidenceDir, { recursive: true });
    const checks = {};
    const notes = [];
    const check = (name, ok, detail) => {
        checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) };
        notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
        console.error(`[live-dogfood] ${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail).slice(0, 200)}`}`);
    };

    const renderer = async (script) => await win.webContents.executeJavaScript(script);
    const waitFor = async (label, predicate, timeoutMs = 240_000) => {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            try {
                last = await predicate();
                if (last) return last;
            } catch (error) {
                last = { error: String(error?.message ?? error).slice(0, 300) };
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
    };

    const capture = async (name) => {
        const image = await win.webContents.capturePage();
        const path = join(evidenceDir, name);
        const png = image.toPNG();
        await writeFile(path, png);
        return { name, path, bytes: png.length };
    };

    const result = {
        schema: "sovereignbot.desktop.live-codex-dogfood.v1",
        evidenceDir,
        checks,
        screenshots: [],
        notes,
    };

    try {
        console.error("[live-dogfood] Step 1: Waiting for production Electron document...");
        await waitFor("production Desktop document", async () => await renderer("document.readyState === 'complete'"));

        console.error("[live-dogfood] Step 2: Verifying live Codex provider presence...");
        const providerStatus = await waitFor("Codex provider ready", async () => {
            const host = getHost();
            const roster = host?.rosterSummary?.();
            const codex = roster?.providers?.codex;
            if (codex?.usable === true) return codex;
            return false;
        }, 30_000);
        check("LIVE_CODEX_PROVIDER_USABLE", providerStatus.usable === true, providerStatus);

        console.error("[live-dogfood] Step 3: Installing Software Team via Welcome UI...");
        await renderer("document.getElementById('welcome-install-software-team')?.click(); true");

        const installed = await waitFor("Software Team installation", async () => await renderer(`(async()=>{
            const teams = await window.sovereignbot.teams.list({});
            const team = teams.teams?.[0];
            const channel = team?.channels?.[0];
            return team && channel && document.getElementById("conversation-title")?.textContent === channel.name
                ? { team, channel }
                : false;
        })()`), 30_000);

        const team = installed.team;
        const channel = installed.channel;
        check("SOFTWARE_TEAM_INSTALLED", team.name === "Software Team" && team.coworkers.length === 3, { team: team.name, channel: channel.name });
        result.screenshots.push(await capture("1-software-team-installed.png"));

        const services = getServices();
        const sharedWorkspacePath = services.workspacePath(team.sharedWorkspaceId);
        check("SHARED_WORKSPACE_READY", Boolean(sharedWorkspacePath && existsSync(sharedWorkspacePath)), { path: sharedWorkspacePath });

        const codingLead = team.coworkers.find((c) => c.key === "coding-lead" || c.name.includes("Coding"));
        const reviewer = team.coworkers.find((c) => c.key === "reviewer" || c.name.includes("Reviewer"));

        console.error("[live-dogfood] Step 4: Dispatching targeted task to Chief of Staff to delegate to Coding Lead...");
        const initialPrompt = "Chief, please coordinate this delivery with the team: have Coding Lead implement a Python utility `math_helper.py` in the workspace with `fibonacci(n)`, then have Reviewer verify it.";
        await renderer(`(()=>{
            const input = document.getElementById("composer-input");
            input.value = ${JSON.stringify(initialPrompt)};
            input.dispatchEvent(new Event("input", { bubbles: true }));
            document.getElementById("composer-form").requestSubmit();
            return true;
        })()`);

        console.error("[live-dogfood] Step 5: Waiting for specialist execution (Coding Lead or Reviewer)...");
        const specialistActive = await waitFor("Chief handoff to specialist", async () => await renderer(`(async()=>{
            const conversation = await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} });
            const teamInfo = (await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })).flow;
            const isSpecialist = ["coding-lead", "reviewer"].includes(teamInfo.stage)
                || [${JSON.stringify(codingLead?.id)}, ${JSON.stringify(reviewer?.id)}].includes(teamInfo.currentOwnerId)
                || conversation.messages.length >= 2;
            return isSpecialist ? { conversation, flow: teamInfo } : false;
        })()`), 120_000);
        check("SPECIALIST_STAGE_REACHED", Boolean(specialistActive), specialistActive?.flow);
        result.screenshots.push(await capture("2-specialist-active.png"));

        console.error("[live-dogfood] Step 6: Triggering User Redirect during active work...");
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const redirectPrompt = "Wait, before finalizing, also make sure `math_helper.py` includes an `is_prime(n)` function alongside `fibonacci(n)`.";
        await renderer(`(()=>{
            const redirectBtn = document.getElementById("conversation-redirect");
            if (redirectBtn && !redirectBtn.classList.contains("hidden")) {
                redirectBtn.click();
            }
            const input = document.getElementById("composer-input");
            input.value = ${JSON.stringify(redirectPrompt)};
            input.dispatchEvent(new Event("input", { bubbles: true }));
            document.getElementById("composer-form").requestSubmit();
            return true;
        })()`);

        console.error("[live-dogfood] Step 7: Captured redirect submission state...");
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        result.screenshots.push(await capture("3-redirect-submitted.png"));

        console.error("[live-dogfood] Step 8: Waiting for team flow to proceed through review and completion...");
        const finalDelivery = await waitFor("Software Team completion after redirect", async () => await renderer(`(async()=>{
            const conversation = await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} });
            const teamInfo = (await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })).flow;
            const isDone = teamInfo.stage === "complete" || (conversation.messages.length >= 4 && !teamInfo.activeProtocol);
            return isDone ? { conversation, flow: teamInfo } : false;
        })()`), 240_000);
        check("TEAM_WORKFLOW_COMPLETED", Boolean(finalDelivery), finalDelivery?.flow);
        result.screenshots.push(await capture("4-chief-synthesis.png"));

        console.error("[live-dogfood] Step 9: Inspecting workspace artifacts and code quality...");
        const filesInWorkspace = readdirSync(sharedWorkspacePath);
        const mathHelperExists = filesInWorkspace.includes("math_helper.py");
        check("WORKSPACE_FILE_WRITTEN", mathHelperExists, { files: filesInWorkspace });

        let mathHelperContent = "";
        if (mathHelperExists) {
            mathHelperContent = await readFile(join(sharedWorkspacePath, "math_helper.py"), "utf8");
            check("FIBONACCI_IMPLEMENTED", mathHelperContent.includes("fibonacci"), { preview: mathHelperContent.slice(0, 200) });
            check("IS_PRIME_IMPLEMENTED", mathHelperContent.includes("is_prime"), { preview: mathHelperContent.slice(0, 400) });
        }

        const messages = finalDelivery.conversation.messages;
        const allText = messages.map((m) => m.text).join("\n");
        const hasLeakedTokens = /bearer\s+|access_token|refresh_token/i.test(allText);
        const hasLeakedDataDir = allText.includes(dataDir);
        check("PRIVACY_BOUNDARY_PRESERVED", !hasLeakedTokens && !hasLeakedDataDir, { leakedTokens: hasLeakedTokens, leakedDataDir: hasLeakedDataDir });

        check("LIVE_DOGFOOD_ALL_PASSED", Object.values(checks).every((c) => c.ok === true), checks);
    } catch (error) {
        check("LIVE_DOGFOOD_EXCEPTION", false, { error: String(error?.stack ?? error) });
        result.screenshots.push(await capture("error-state.png").catch(() => null));
    }

    return result;
}
