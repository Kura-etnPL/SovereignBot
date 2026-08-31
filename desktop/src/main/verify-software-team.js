import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_EVIDENCE_DIR = join(process.cwd(), "..", "..", "..", "runtime", "sovereign-control", "v45-software-team");
const FORBIDDEN_PUBLIC_MARKERS = [
    "providerAccountId", "sessionId", "access_token", "refresh_token", "cookie", "localStorage",
    "indexeddb", "user-data", "credentials", "storageRelativePath",
];

function containsAny(value, markers) {
    const text = JSON.stringify(value ?? "").toLowerCase();
    return markers.find((marker) => text.includes(String(marker).toLowerCase()));
}

function publicWorkspaceShape(workspaces) {
    return Array.isArray(workspaces) && workspaces.every((entry) =>
        entry && typeof entry.id === "string" && typeof entry.label === "string" && !Object.hasOwn(entry, "path"));
}

function modelProfileShape(coworkers) {
    const allowed = new Set(["automatic", "efficient", "deep", "economy", "custom"]);
    return Array.isArray(coworkers) && coworkers.every((entry) => {
        const binding = entry?.modelBinding;
        return binding && Object.keys(binding).sort().join(",") === "profile" && allowed.has(binding.profile);
    });
}

export async function runVerifySoftwareTeam({
    win,
    dataDir,
    getHost,
    getServices,
    getCoworkerStore,
    getConversationStore,
    getTeamService,
    evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR,
} = {}) {
    await mkdir(evidenceDir, { recursive: true });
    const checks = {};
    const notes = [];
    const check = (name, ok, detail) => {
        checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) };
        notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
    };
    const renderer = async (script) => await win.webContents.executeJavaScript(script);
    const waitFor = async (label, predicate, timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        let last;
        while (Date.now() < deadline) {
            try {
                last = await predicate();
                if (last) return last;
            }
            catch (error) {
                last = { error: String(error?.message ?? error).slice(0, 300) };
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
    };
    const capture = async (name) => {
        const image = await win.capturePage(undefined, { stayAwake: true });
        if (!image || image.isEmpty()) throw new Error(`empty screenshot: ${name}`);
        const path = join(evidenceDir, name);
        await writeFile(path, image.toPNG());
        return { name, path, bytes: image.toPNG().length };
    };

    const result = {
        schema: "sovereignbot.desktop.software-team-canary.v1",
        evidenceDir,
        checks,
        screenshots: [],
        notes,
    };

    try {
        await waitFor("production Desktop document", async () => await renderer("document.readyState === 'complete'"));
        const boot = await renderer(`({
            protocol: location.protocol,
            hasTeams: typeof window.sovereignbot?.teams?.installPack === "function",
            hasChannels: typeof window.sovereignbot?.channels?.list === "function",
            hasSend: typeof window.sovereignbot?.conversations?.send === "function",
            installButton: !!document.getElementById("welcome-install-software-team")
        })`);
        check("PRODUCTION_ELECTRON_IPC_SURFACE", boot.protocol === "sovereignbot:" && boot.hasTeams && boot.hasChannels && boot.hasSend && boot.installButton, boot);

        const initialTeams = await renderer("window.sovereignbot.teams.list({})");
        check("FRESH_TEAM_INSTALL_STATE", initialTeams?.teams?.length === 0, { teamCount: initialTeams?.teams?.length ?? -1 });

        await renderer("document.getElementById('welcome-install-software-team')?.click(); true");
        const installed = await waitFor("Software Team installation", async () => await renderer(`(async()=>{
            const teams = await window.sovereignbot.teams.list({});
            const team = teams.teams?.[0];
            const channel = team?.channels?.[0];
            return team && channel && document.getElementById("conversation-title")?.textContent === channel.name
                ? { team, channel, body: document.body.innerText }
                : false;
        })()`));
        const team = installed.team;
        const channel = installed.channel;
        const names = team.coworkers.map((entry) => entry.name);
        check("SOFTWARE_TEAM_INSTALLED", team.name === "Software Team" && names.join("|") === "Chief of Staff|Coding Lead|Reviewer", { name: team.name, coworkers: names });
        check("PROJECT_CHANNEL_READY", channel.name === "Project Channel" && channel.kind === "project" && channel.conversationId === team.channels[0].conversationId, { channel: channel.name, kind: channel.kind });
        check("INSTALLATION_UI_VISIBLE", installed.body.includes("Software Team") && installed.body.includes("Project Channel"), { title: documentTitle(installed.body) });
        result.screenshots.push(await capture("software-team-install.png"));

        const publicState = await renderer(`(async()=>({
            coworkers: await window.sovereignbot.coworkers.list({}),
            teams: await window.sovereignbot.teams.list({}),
            channels: await window.sovereignbot.channels.list({}),
            workspaces: await window.sovereignbot.workspaces.list({}),
            conversation: await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} }),
            roster: await window.sovereignbot.providers.getRoster({})
        }))()`);
        const publicText = JSON.stringify(publicState);
        check("PUBLIC_MODEL_PROFILES_ONLY", modelProfileShape(publicState.coworkers?.coworkers), publicState.coworkers?.coworkers?.map((entry) => entry.modelBinding));
        check("PUBLIC_WORKSPACE_REDACTION", publicWorkspaceShape(publicState.workspaces?.workspaces) && !containsAny(publicState.workspaces, ["path", dataDir]), { workspaceCount: publicState.workspaces?.workspaces?.length ?? -1 });
        check("PUBLIC_TEAM_SURFACE_REDACTION", !containsAny(publicText, [dataDir, ...FORBIDDEN_PUBLIC_MARKERS]), { forbidden: containsAny(publicText, [dataDir, ...FORBIDDEN_PUBLIC_MARKERS]) ?? null });

        const internalCoworkers = getCoworkerStore().listInternal().coworkers;
        const services = getServices();
        const sharedPath = services.workspacePath(team.sharedWorkspaceId);
        const privateWorkspacePaths = team.coworkerIds.map((id) => {
            const coworker = internalCoworkers.find((entry) => entry.id === id);
            return (coworker?.workspaceIds ?? []).map((workspaceId) => services.workspacePath(workspaceId)).find(Boolean);
        });
        check("PRIVATE_SCRATCHES_MATERIALIZED", privateWorkspacePaths.length === 3 && privateWorkspacePaths.every((path) => typeof path === "string" && existsSync(path)), { count: privateWorkspacePaths.filter(Boolean).length });
        check("SHARED_PROJECT_WORKSPACE_MATERIALIZED", typeof sharedPath === "string" && existsSync(sharedPath), { available: Boolean(sharedPath) });
        check("THIS_PC_LABEL", await renderer(`(()=>{
            document.getElementById("nav-work")?.click();
            document.getElementById("work-new")?.click();
            return [...(document.getElementById("job-execution")?.options || [])].map((entry) => entry.textContent);
        })()`), await renderer("[...(document.getElementById('job-execution')?.options || [])].map((entry) => entry.textContent)"));
        const thisPcOptions = await renderer("[...(document.getElementById('job-execution')?.options || [])].map((entry) => entry.textContent)");
        check("THIS_PC_LABEL_EXACT", thisPcOptions.includes("This PC / 此电脑"), thisPcOptions);
        await renderer("document.getElementById('job-dialog')?.close(); true");
        await renderer("document.querySelector('#team-list button')?.click(); true");
        await waitFor("Project Channel return", async () => await renderer(`document.getElementById("conversation-title")?.textContent === ${JSON.stringify(channel.name)}`));
        await renderer("document.getElementById('open-details')?.click(); true");
        await new Promise((resolve) => setTimeout(resolve, 200));
        const normalDetails = await renderer("document.getElementById('details-panel')?.innerText || ''");
        check("NORMAL_UI_MODEL_PROFILE_ONLY", /Model profile \/ 模型档位/i.test(normalDetails) && !/\bCodex\b|Claude Code|provider/i.test(normalDetails), normalDetails);
        result.screenshots.push(await capture("software-team-roster.png"));

        const inputText = "Create a small delivery note, implement it in the shared project workspace, and return the result for review.";
        await renderer(`(()=>{
            const input = document.getElementById("composer-input");
            input.value = ${JSON.stringify(inputText)};
            input.dispatchEvent(new Event("input", { bubbles: true }));
            document.getElementById("composer-form").requestSubmit();
            return true;
        })()`);
        const firstHandoff = await waitFor("Chief handoff", async () => await renderer(`(async()=>{
            const conversation = await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} });
            const team = (await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })).flow;
            return conversation.messages.length >= 2 && team.stage === "coding-lead" ? { conversation, flow: team } : false;
        })()`), 45_000);
        check("CHIEF_TO_CODING_LEAD_HANDOFF", firstHandoff.flow.stage === "coding-lead" && firstHandoff.flow.currentOwner?.includes("Coding Lead"), firstHandoff.flow);
        await new Promise((resolve) => setTimeout(resolve, 100));
        result.screenshots.push(await capture("software-team-handoff.png"));

        const finished = await waitFor("Software Team delivery flow", async () => await renderer(`(async()=>{
            const conversation = await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} });
            const team = (await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })).flow;
            return conversation.messages.length >= 5 && team.stage === "complete" ? { conversation, flow: team } : false;
        })()`), 90_000);
        const messages = finished.conversation.messages;
        const [chiefId, codingLeadId, reviewerId] = team.coworkerIds;
        const senderOrder = messages.slice(-5).map((entry) => entry.senderId);
        check("SOFTWARE_TEAM_HANDOFF_ORDER", senderOrder.join("|") === ["user", chiefId, codingLeadId, reviewerId, chiefId].join("|"), senderOrder);
        check("ONE_OWNER_USER_DELIVERY", Object.keys(messages[0]?.delivery ?? {}).join("|") === chiefId && Object.values(messages[0]?.delivery ?? {}).every((entry) => entry.status === "delivered"), messages[0]?.delivery);
        check("REVIEWER_HANDOFF_AND_ARTIFACT", messages[3]?.senderId === reviewerId && Array.isArray(messages[3]?.artifactIds) && messages[3].artifactIds.length > 0, { artifactCount: messages[3]?.artifactIds?.length ?? 0 });
        const artifacts = await renderer(`window.sovereignbot.artifacts.list(${JSON.stringify({ conversationId: channel.conversationId, limit: 20 })})`);
        check("ARTIFACT_RESULT_VISIBLE", artifacts?.artifacts?.length > 0 && !containsAny(artifacts, [dataDir, "storageRelativePath"]), { artifactCount: artifacts?.artifacts?.length ?? 0 });
        await waitFor("final result visible in Desktop", async () => {
            const body = await renderer("document.body.innerText");
            return body.includes("WORKER RESULT(fake)") && body.includes("Project Channel") && body.includes("Reviewer") ? body : false;
        }, 15_000);
        const finalSurface = await renderer(`(async()=>({
            body: document.body.innerText,
            conversation: await window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(channel.conversationId)} }),
            team: await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })
        }))()`);
        check("FINAL_RESULT_VISIBLE", finalSurface.body.includes("WORKER RESULT(fake)") && finalSurface.body.includes("Project Channel") && finalSurface.body.includes("Reviewer"), { messageCount: finalSurface.conversation.messages.length, stage: finalSurface.team.flow.stage });
        check("FINAL_PUBLIC_SURFACE_REDACTED", !containsAny(finalSurface, [dataDir, ...FORBIDDEN_PUBLIC_MARKERS]), { forbidden: containsAny(finalSurface, [dataDir, ...FORBIDDEN_PUBLIC_MARKERS]) ?? null });
        result.screenshots.push(await capture("software-team-final.png"));

        const stageOwners = [
            firstHandoff.flow.currentOwner,
            messages[2]?.senderId === codingLeadId ? "Coding Lead" : undefined,
            messages[3]?.senderId === reviewerId ? "Reviewer" : undefined,
            messages[4]?.senderId === chiefId ? "Chief of Staff" : undefined,
        ];
        check("OWNER_STATUS_AND_FINAL_SYNTHESIS", stageOwners[0]?.includes("Coding Lead") && stageOwners.slice(1).every(Boolean) && finished.flow.stage === "complete", stageOwners);
    }
    catch (error) {
        result.error = String(error?.stack ?? error).slice(0, 4_000);
        check("SOFTWARE_TEAM_CANARY_COMPLETED", false, String(error?.message ?? error).slice(0, 500));
    }
    result.ok = Object.values(checks).every((entry) => entry.ok);
    if (result.ok)
        check("SOFTWARE_TEAM_CANARY_COMPLETED", true);
    result.ok = Object.values(checks).every((entry) => entry.ok);
    return result;
}

function documentTitle(body) {
    return String(body ?? "").split("\n").find((line) => line.includes("Project Channel")) ?? "Project Channel";
}
