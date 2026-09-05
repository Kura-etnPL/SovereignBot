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
        const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
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

        if (process.env.SOVEREIGNBOT_LIVE_RESTART_CHECK === "1") {
            if (process.env.SOVEREIGNBOT_INSPECT_INTERRUPTED === "1") {
                const restored = await waitFor("interrupted delivery attention", async () => await renderer(`(async () => {
                    const team = (await window.sovereignbot.teams.list({})).teams?.[0];
                    if (!team) return false;
                    const conversation = await window.sovereignbot.conversations.get({conversationId: team.channels[0].conversationId});
                    const interrupted = conversation.messages.flatMap(message => Object.values(message.delivery ?? {})).filter(delivery => delivery.status === "attention" && /interrupted by application restart/i.test(delivery.detail ?? ""));
                    return interrupted.length ? {count: interrupted.length, channel: team.channels[0].name} : false;
                })()`), 15_000);
                const tasks = await getHost().runtime.orchestrator.listTasks();
                check("INTERRUPTED_DELIVERY_ATTENTION", restored.count > 0);
                check("INTERRUPTED_NO_ACTIVE_EXECUTION", !tasks.some(task => ["running", "accepted", "queued"].includes(task.status)));
                check("INTERRUPTED_NO_TASK_REPLAY", tasks.length === Number(process.env.SOVEREIGNBOT_EXPECTED_TASK_COUNT));
                await waitFor("restored channel navigation", async () => await renderer(`Boolean(document.querySelector('.nav-channel-sublist button'))`), 10_000);
                await renderer(`document.querySelector('.nav-channel-sublist button').click(); true`);
                await waitFor("restored channel UI", async () => await renderer(`document.getElementById('conversation-title')?.textContent === ${JSON.stringify(restored.channel)}`), 10_000);
                const redirect = await renderer(`(() => { const button = document.getElementById('conversation-redirect'); return Boolean(button && !button.classList.contains('hidden')); })()`);
                check("INTERRUPTED_REDIRECT_AVAILABLE", redirect);
                check("INTERRUPTED_CHANNEL_VISIBLE", await renderer(`getComputedStyle(document.getElementById('view-welcome')).display === 'none' && document.getElementById('conversation-redirect').getBoundingClientRect().width > 0`));
                win.webContents.setBackgroundThrottling(false);
                await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
                win.webContents.invalidate();
                await renderer(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                result.screenshots.push(await capture("interrupted-recovery.png"));
                await writeFile(join(evidenceDir, "interrupted-result.json"), JSON.stringify(result, null, 2), "utf8");
                return result;
            }
            const restored = await renderer(`(async () => {
                const team = (await window.sovereignbot.teams.list({})).teams?.[0];
                if (!team) throw new Error("Team missing after restart");
                const detail = await window.sovereignbot.teams.get({teamId: team.id});
                const conversation = await window.sovereignbot.conversations.get({conversationId: team.channels[0].conversationId});
                const artifactId = conversation.messages.flatMap(message => message.artifactIds ?? []).at(-1);
                const preview = artifactId ? await window.sovereignbot.artifacts.preview({artifactId}) : undefined;
                return {complete: detail.flow?.stage === "complete", messages: conversation.messages.length, artifact: Boolean(artifactId), preview: Boolean(preview && JSON.stringify(preview).includes("fibonacci"))};
            })()`);
            check("RESTART_TEAM_COMPLETE", restored.complete);
            check("RESTART_CONVERSATION_PERSISTED", restored.messages >= 4);
            check("RESTART_ARTIFACT_PREVIEW", restored.artifact && restored.preview);
            await writeFile(join(evidenceDir, "restart-result.json"), JSON.stringify(result, null, 2), "utf8");
            return result;
        }

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
        for (const coworker of team.coworkers) {
            getCoworkerStore().update(coworker.id, { modelBinding: { profile: "custom", provider: "codex", model: "gpt-5.6-luna" } });
        }
        await renderer("window.sovereignbot.providers.refresh({})");
        const agents = getHost().runtime.config?.agents ?? getHost().runtime.runtimeConfig?.agents;
        if (!Array.isArray(agents) || agents.some(agent => agent.harness.kind === "codex" && agent.harness.model !== "gpt-5.6-luna"))
            throw new Error("Cannot verify the Luna-only runtime roster; no prompt sent");
        check("LUNA_ONLY_ROSTER", true, { model: "gpt-5.6-luna", agents: agents.length });

        console.error("[live-dogfood] Step 4: Dispatching targeted task to Chief of Staff to delegate to Coding Lead...");
        const initialPrompt = "Chief, deliver a tiny dependency-free JavaScript module math_helper.mjs in the team workspace. Coding Lead must implement named exports fibonacci(n) and isPrime(n), and test with the installed Node.js runtime. Reviewer independently checks the file, then Chief summarizes and attaches the actual file as an Artifact. Keep each reply brief. No Python, packages, network, git operations or unrelated files. fibonacci(0)=0, fibonacci(10)=55; negative/noninteger Fibonacci inputs throw. isPrime(2)=true, isPrime(9)=false, isPrime(1)=false; noninteger inputs throw. Coordinate autonomously and finish the delivery.";
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
                ;
            return isSpecialist ? { conversation, flow: teamInfo } : false;
        })()`), 120_000);
        check("SPECIALIST_STAGE_REACHED", Boolean(specialistActive), specialistActive?.flow);
        result.screenshots.push(await capture("2-specialist-active.png"));

        if (process.env.SOVEREIGNBOT_LIVE_TEST_REDIRECT === "1") {
        console.error("[live-dogfood] Step 6: Triggering User Redirect during active work...");
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        const redirectPrompt = "Before finalizing, also ensure both functions reject noninteger inputs.";
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
        }

        console.error("[live-dogfood] Step 8: Waiting for team flow to proceed through review and completion...");
        const finalDelivery = await waitFor("Software Team completion after redirect", async () => await renderer(`(async()=>{
            const conversation = await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} });
            const teamInfo = (await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })).flow;
            const isDone = teamInfo.stage === "complete";
            return isDone ? { conversation, flow: teamInfo } : false;
        })()`), 480_000);
        check("TEAM_WORKFLOW_COMPLETED", Boolean(finalDelivery), finalDelivery?.flow);
        result.screenshots.push(await capture("4-chief-synthesis.png"));

        console.error("[live-dogfood] Step 9: Inspecting workspace artifacts and code quality...");
        const filesInWorkspace = readdirSync(sharedWorkspacePath);
        const mathHelperExists = filesInWorkspace.includes("math_helper.mjs");
        check("WORKSPACE_FILE_WRITTEN", mathHelperExists, { files: filesInWorkspace });

        let mathHelperContent = "";
        if (mathHelperExists) {
            mathHelperContent = await readFile(join(sharedWorkspacePath, "math_helper.mjs"), "utf8");
            check("FIBONACCI_IMPLEMENTED", mathHelperContent.includes("fibonacci"), { preview: mathHelperContent.slice(0, 200) });
            check("IS_PRIME_IMPLEMENTED", mathHelperContent.includes("isPrime"), { preview: mathHelperContent.slice(0, 400) });
        }

        const messages = finalDelivery.conversation.messages;
        const allText = messages.map((m) => m.text).join("\n");
        const hasLeakedTokens = /bearer\s+|access_token|refresh_token/i.test(allText);
        const hasLeakedDataDir = allText.includes(dataDir);
        check("PRIVACY_BOUNDARY_PRESERVED", !hasLeakedTokens && !hasLeakedDataDir, { leakedTokens: hasLeakedTokens, leakedDataDir: hasLeakedDataDir });

        check("LIVE_DOGFOOD_ALL_PASSED", Object.values(checks).every((c) => c.ok === true));
    } catch (error) {
        check("LIVE_DOGFOOD_EXCEPTION", false, { error: String(error?.stack ?? error) });
        result.screenshots.push(await capture("error-state.png").catch(() => null));
    }

    await writeFile(join(evidenceDir, "live-result.json"), JSON.stringify(result, null, 2), "utf8");
    return result;
}
