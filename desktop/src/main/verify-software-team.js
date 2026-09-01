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
    const expectRendererReject = async (script) => {
        try {
            await renderer(script);
            return false;
        }
        catch {
            return true;
        }
    };
    const capture = async (name) => {
        const attempts = [];
        let image;
        try {
            await new Promise((resolve) => setTimeout(resolve, 250));
            image = await win.capturePage(undefined, { stayAwake: true });
        }
        catch (error) {
            attempts.push({ method: "BrowserWindow.capturePage", error: String(error?.message ?? error).slice(0, 300) });
        }
        if (!image || image.isEmpty()) {
            try {
                const { desktopCapturer } = await import("electron");
                const bounds = win.getBounds();
                const sourceId = win.getMediaSourceId();
                const sources = await desktopCapturer.getSources({
                    types: ["window"],
                    thumbnailSize: { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) },
                    fetchWindowIcons: false,
                });
                const source = sources.find((entry) => entry.id === sourceId) ?? sources.find((entry) => entry.name === win.getTitle());
                if (!source?.thumbnail || source.thumbnail.isEmpty()) throw new Error("desktopCapturer returned no BrowserWindow thumbnail");
                image = source.thumbnail;
            }
            catch (error) {
                attempts.push({ method: "desktopCapturer.window", error: String(error?.message ?? error).slice(0, 300) });
            }
        }
        if (!image || image.isEmpty()) throw new Error(`screenshot failed for ${name}: ${JSON.stringify(attempts)}`);
        const path = join(evidenceDir, name);
        let png;
        try { png = image.toPNG(); }
        catch (error) { throw new Error(`toPNG failed for ${name}: ${String(error?.stack ?? error)}`); }
        await writeFile(path, png);
        return { name, path, bytes: png.length };
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
            hasConnectedApps: typeof window.sovereignbot?.connectedApps?.list === "function",
            installButton: !!document.getElementById("welcome-install-software-team")
        })`);
        check("PRODUCTION_ELECTRON_IPC_SURFACE", boot.protocol === "sovereignbot:" && boot.hasTeams && boot.hasChannels && boot.hasSend && boot.hasConnectedApps && boot.installButton, boot);
        const handshake = await renderer("window.sovereignbot.handshake({})");
        check("EXTERNAL_TEAM_CONTROL_READY", handshake?.externalTeamControl?.protocol === "sovereignbot.team-control.v1"
            && handshake.externalTeamControl.transport === "loopback-http"
            && Number.isInteger(handshake.externalTeamControl.port) && handshake.externalTeamControl.port > 0
            && handshake.externalTeamControl.methods.includes("submitOutcome")
            && handshake.externalTeamControl.methods.includes("getOutcomeStatus")
            && handshake.externalTeamControl.methods.includes("requestTakeover"), handshake?.externalTeamControl);

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

        const connectedApps = await renderer("window.sovereignbot.connectedApps.list({})");
        check("CONNECTED_APPS_PRODUCT_SURFACE", connectedApps?.apps?.length >= 2
            && connectedApps.apps.some((entry) => entry.id === "sovereignbot-computer" && entry.name.includes("This PC") && entry.authority === "Governor-controlled")
            && connectedApps.apps.some((entry) => entry.id === "sovereignbot-workspace" && entry.authority === "Governor-controlled")
            && !containsAny(connectedApps, [dataDir, "governedTools", "profileDir", "workspacePath"]), connectedApps);

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
        check("COMPUTER_MODE_PRODUCT_SURFACE", normalDetails.includes("This PC / 此电脑")
            && normalDetails.includes("Shared computer/login / 共享电脑登录")
            && normalDetails.includes("Private computer profile / 私有电脑配置"), normalDetails);
        result.screenshots.push(await capture("software-team-roster.png"));

        await renderer("document.getElementById('details-panel')?.classList.add('hidden'); document.getElementById('nav-settings')?.click(); true");
        const connectedAppsUi = await waitFor("Connected Apps settings surface", async () => await renderer(`(()=>{
            const root = document.getElementById("connected-apps-list");
            return root && root.innerText.includes("This PC / 此电脑") && root.innerText.includes("Project workspace / 项目工作区")
                ? root.innerText : false;
        })()`));
        const connectedAppsUiLower = connectedAppsUi.toLowerCase();
        check("CONNECTED_APPS_UI_VISIBLE", connectedAppsUiLower.includes("available to / 可分配给") && connectedAppsUi.includes("Governor-controlled"), connectedAppsUi);
        await renderer("document.querySelector('#team-list button')?.click(); true");
        await waitFor("Project Channel return after settings", async () => await renderer(`document.getElementById("conversation-title")?.textContent === ${JSON.stringify(channel.name)}`));

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
        check("SOFTWARE_TEAM_HANDOFF_ORDER", senderOrder.join("|") === [codingLeadId, reviewerId, codingLeadId, reviewerId, chiefId].join("|"), senderOrder);
        check("ONE_OWNER_USER_DELIVERY", Object.keys(messages[0]?.delivery ?? {}).join("|") === chiefId && Object.values(messages[0]?.delivery ?? {}).every((entry) => entry.status === "delivered"), messages[0]?.delivery);
        const reviewerArtifactMessage = [...messages].reverse().find((entry) => entry.senderId === reviewerId && Array.isArray(entry.artifactIds) && entry.artifactIds.length > 0);
        check("REVIEWER_HANDOFF_AND_ARTIFACT", Boolean(reviewerArtifactMessage), { artifactCount: reviewerArtifactMessage?.artifactIds?.length ?? 0 });
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
            [...messages].reverse().find((entry) => entry.senderId === codingLeadId) ? "Coding Lead" : undefined,
            [...messages].reverse().find((entry) => entry.senderId === reviewerId) ? "Reviewer" : undefined,
            [...messages].reverse().find((entry) => entry.senderId === chiefId) ? "Chief of Staff" : undefined,
        ];
        check("OWNER_STATUS_AND_FINAL_SYNTHESIS", stageOwners[0]?.includes("Coding Lead") && stageOwners.slice(1).every(Boolean) && finished.flow.stage === "complete", stageOwners);

        // Requirement audit through the independent product pages. These calls use
        // the public preload API and the existing stores; no parallel product engine
        // or test-only persistence is introduced.
        const playbookFlowBefore = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} })`);
        const createdPlaybook = await renderer(`window.sovereignbot.playbooks.create({ playbook: { name: "P0 Canary Method", description: "Bounded product acceptance method", steps: ["chief", "coding-lead", "reviewer", "chief"] } })`);
        const exportedPlaybook = await renderer(`window.sovereignbot.playbooks.export({ playbookId: ${JSON.stringify(createdPlaybook.id)} })`);
        const importedPlaybook = await renderer(`window.sovereignbot.playbooks.import({ playbook: ${JSON.stringify({ ...exportedPlaybook, id: "playbook_p0_imported" })} })`);
        const duplicatedPlaybook = await renderer(`window.sovereignbot.playbooks.duplicate({ playbookId: ${JSON.stringify(createdPlaybook.id)} })`);
        await renderer(`window.sovereignbot.playbooks.update({ playbookId: ${JSON.stringify(createdPlaybook.id)}, patch: { name: "P0 Canary Method Updated", description: "Updated bounded method", steps: ["chief", "reviewer", "chief"] } })`);
        await renderer(`window.sovereignbot.playbooks.assign({ playbookId: ${JSON.stringify(createdPlaybook.id)}, teamId: ${JSON.stringify(team.id)} })`);
        await renderer(`window.sovereignbot.playbooks.assign({ playbookId: "playbook_p0_imported", channelId: ${JSON.stringify(channel.id)} })`);
        await renderer(`window.sovereignbot.playbooks.archive({ playbookId: "playbook_p0_imported" })`);
        await renderer(`window.sovereignbot.playbooks.restore({ playbookId: "playbook_p0_imported" })`);
        const playbookState = await renderer(`(async()=>({ library: await window.sovereignbot.playbooks.list({ includeArchived: true }), team: await window.sovereignbot.teams.get({ teamId: ${JSON.stringify(team.id)} }) }))()`);
        check("P0_PLAYBOOK_LIBRARY_LIFECYCLE", createdPlaybook.id && exportedPlaybook.schema === "sovereignbot.desktop.playbook.v1"
            && importedPlaybook.imported === true && duplicatedPlaybook.name === "P0 Canary Method copy"
            && playbookState.library.playbooks.some((entry) => entry.id === "playbook_p0_imported" && entry.state === "active")
            && playbookState.library.playbooks.some((entry) => entry.id === createdPlaybook.id && entry.name === "P0 Canary Method Updated")
            && playbookState.team.playbooks.some((entry) => entry.id === createdPlaybook.id)
            && playbookState.team.channels.some((entry) => entry.id === channel.id && entry.playbookId === "playbook_p0_imported")
            && playbookState.team.flow.stage === playbookFlowBefore.flow.stage, {
            imported: importedPlaybook.imported,
            duplicate: duplicatedPlaybook.name,
            assignedTeam: playbookState.team.playbooks.some((entry) => entry.id === createdPlaybook.id),
            assignedChannel: playbookState.team.channels.some((entry) => entry.id === channel.id && entry.playbookId === "playbook_p0_imported"),
            flowStage: playbookState.team.flow.stage,
        });
        check("P0_PLAYBOOK_AUTHORITY_REJECTED", await expectRendererReject(`window.sovereignbot.playbooks.import({ playbook: ${JSON.stringify({ ...exportedPlaybook, id: "playbook_p0_authority", capabilityGrant: "workspace" })} })`));

        const createdSkill = await renderer(`window.sovereignbot.skills.create({ skill: { name: "P0 Canary Skill", description: "Safe declarative skill", instructions: "Summarize the bounded acceptance evidence." } })`);
        const exportedSkill = await renderer(`window.sovereignbot.skills.export({ skillId: ${JSON.stringify(createdSkill.id)} })`);
        const importedSkill = await renderer(`window.sovereignbot.skills.import({ skill: ${JSON.stringify({ ...exportedSkill, name: "P0 Imported Skill" })} })`);
        const duplicatedSkill = await renderer(`window.sovereignbot.skills.duplicate({ skillId: ${JSON.stringify(createdSkill.id)} })`);
        await renderer(`window.sovereignbot.skills.assign({ skillId: ${JSON.stringify(createdSkill.id)}, targetKind: "team", targetId: ${JSON.stringify(team.id)}, enabled: true })`);
        await renderer(`window.sovereignbot.skills.assign({ skillId: ${JSON.stringify(createdSkill.id)}, targetKind: "coworker", targetId: ${JSON.stringify(chiefId)}, enabled: true })`);
        const retestedSkill = await renderer(`window.sovereignbot.skills.retest({ skillId: ${JSON.stringify(createdSkill.id)} })`);
        const archivedSkill = await renderer(`window.sovereignbot.skills.archive({ skillId: ${JSON.stringify(duplicatedSkill.id)} })`);
        const restoredSkill = await renderer(`window.sovereignbot.skills.restore({ skillId: ${JSON.stringify(duplicatedSkill.id)} })`);
        const routine = await renderer(`window.sovereignbot.routines.create({ name: "P0 Canary Routine", instruction: "Run the P0 canary skill through the governed Job path.", coworkerId: ${JSON.stringify(chiefId)}, skillId: ${JSON.stringify(createdSkill.id)}, workspaceId: ${JSON.stringify(team.sharedWorkspaceId)}, schedule: { type: "one-time", at: new Date(Date.now() + 3_600_000).toISOString() } })`);
        const routineListed = await renderer(`window.sovereignbot.routines.list({})`);
        await renderer(`window.sovereignbot.routines.remove({ routineId: ${JSON.stringify(routine.id)} })`);
        check("P0_SKILL_LIBRARY_LIFECYCLE", createdSkill.id && exportedSkill.schema === "sovereignbot.desktop.skill.v1"
            && importedSkill.imported === true && duplicatedSkill.name === "P0 Canary Skill copy"
            && retestedSkill.tested === true && archivedSkill.state === "archived" && restoredSkill.state === "active"
            && routineListed.routines.some((entry) => entry.id === routine.id && entry.skillId === createdSkill.id)
            && (await renderer(`window.sovereignbot.skills.get({ skillId: ${JSON.stringify(createdSkill.id)} })`)).assignedTeamIds.includes(team.id), {
            imported: importedSkill.imported,
            duplicate: duplicatedSkill.name,
            retested: retestedSkill.mode,
            routine: routine.id,
        });
        check("P0_SKILL_AUTHORITY_REJECTED", await expectRendererReject(`window.sovereignbot.skills.import({ skill: ${JSON.stringify({ ...exportedSkill, name: "P0 Authority Skill", capabilityGrant: "computer" })} })`));

        const duplicatedPack = await renderer('window.sovereignbot.teams.duplicatePack({ packId: "software-team" })');
        const editedPack = await renderer(`window.sovereignbot.teams.editPack({ packId: ${JSON.stringify(duplicatedPack.id)}, patch: { name: "P0 Edited Software Recipe", description: "Edited safe recipe" } })`);
        const exportedPack = await renderer(`window.sovereignbot.teams.exportPackRecipe({ packId: ${JSON.stringify(duplicatedPack.id)} })`);
        const packCatalog = await renderer("window.sovereignbot.teams.list({})");
        check("P0_TEAM_PACK_GALLERY_ROUNDTRIP", packCatalog.packs.some((entry) => entry.id === "software-team" && entry.category === "Software")
            && packCatalog.packs.some((entry) => entry.id === "research-team" && entry.category === "Research")
            && packCatalog.packs.some((entry) => entry.id === "content-team" && entry.category === "Content")
            && packCatalog.packs.some((entry) => entry.id === "operations-team" && entry.category === "Operations")
            && editedPack.name === "P0 Edited Software Recipe" && exportedPack.name === editedPack.name
            && exportedPack.schema === "sovereignbot.desktop.team-pack.v1", {
            firstPartyCategories: [...new Set(packCatalog.packs.filter((entry) => !entry.custom).map((entry) => entry.category))],
            customPack: duplicatedPack.id,
        });
        check("P0_TEAM_PACK_AUTHORITY_REJECTED", await expectRendererReject(`window.sovereignbot.teams.editPack({ packId: ${JSON.stringify(duplicatedPack.id)}, patch: { capabilityGrant: "computer" } })`));

        const workChannel = await renderer(`window.sovereignbot.channels.create({ teamId: ${JSON.stringify(team.id)}, name: "P0 Work Room", kind: "work", instructions: "Bounded work updates.", workspaceId: ${JSON.stringify(team.sharedWorkspaceId)}, playbookId: "software-delivery" })`);
        const personalChannel = await renderer(`window.sovereignbot.channels.create({ teamId: ${JSON.stringify(team.id)}, name: "P0 Personal Room", kind: "personal", instructions: "Personal planning only.", workspaceId: ${JSON.stringify(team.sharedWorkspaceId)}, playbookId: "software-delivery" })`);
        const updatedWorkChannel = await renderer(`window.sovereignbot.channels.update({ channelId: ${JSON.stringify(workChannel.channel.id)}, patch: { name: "P0 Work Room Updated", instructions: "Updated bounded work updates." } })`);
        await renderer(`window.sovereignbot.channels.archive({ channelId: ${JSON.stringify(personalChannel.channel.id)} })`);
        const restoredPersonalChannel = await renderer(`window.sovereignbot.channels.restore({ channelId: ${JSON.stringify(personalChannel.channel.id)} })`);
        getConversationStore().postCoworkerMessage(workChannel.channel.conversationId, codingLeadId, { text: "P0 unread activity update" });
        await renderer("window.refreshConversations?.(); true");
        const channelCatalog = await renderer(`window.sovereignbot.channels.list({ teamId: ${JSON.stringify(team.id)}, includeArchived: true })`);
        check("P0_CHANNEL_LIFECYCLE", ["work", "personal", "project"].every((kind) => channelCatalog.channels.some((entry) => entry.kind === kind))
            && updatedWorkChannel.channel.name === "P0 Work Room Updated" && restoredPersonalChannel.channel.archived === false, {
            kinds: [...new Set(channelCatalog.channels.map((entry) => entry.kind))],
            work: updatedWorkChannel.channel.name,
            personalRestored: restoredPersonalChannel.channel.archived === false,
        });

        const artifactHub = await renderer(`window.sovereignbot.artifacts.hub({ channelId: ${JSON.stringify(channel.id)}, type: "text/markdown", limit: 20 })`);
        const artifact = artifactHub.artifacts?.[0];
        const artifactPreview = artifact ? await renderer(`window.sovereignbot.artifacts.preview({ artifactId: ${JSON.stringify(artifact.id)} })`) : undefined;
        const artifactOpen = artifact ? await renderer(`window.sovereignbot.artifacts.open({ artifactId: ${JSON.stringify(artifact.id)} })`) : undefined;
        const artifactReveal = artifact ? await renderer(`window.sovereignbot.artifacts.reveal({ artifactId: ${JSON.stringify(artifact.id)} })`) : undefined;
        check("P0_ARTIFACT_HUB_REAL_ACTIONS", Boolean(artifact?.creator?.name && artifact?.history?.some((entry) => entry.event === "created") && artifactPreview?.preview?.includes("Software delivery")
            && artifactOpen?.ok === true && artifactOpen?.verified === "managed-artifact" && artifactOpen?.action === "open"
            && artifactReveal?.ok === true && artifactReveal?.verified === "managed-artifact" && artifactReveal?.action === "reveal")
            && !containsAny(artifactHub, [dataDir, "storageRelativePath", "sourceRelativePath"]), {
            artifact: artifact?.title,
            creator: artifact?.creator?.name,
            type: artifact?.mimeType,
            history: artifact?.history?.length ?? 0,
            opened: artifactOpen?.ok === true,
            revealed: artifactReveal?.ok === true,
        });

        const computerHistory = await renderer("window.sovereignbot.computer.history({ limit: 100 })");
        check("P0_COMPUTER_HISTORY_REDACTED", Array.isArray(computerHistory.history)
            && computerHistory.history.every((entry) => entry.source && entry.activity && entry.summary && entry.status && entry.timestamp)
            && !containsAny(computerHistory, [dataDir, "session", "cookie", "password", "coordinate", "webdriver", "rawPath"]), {
            count: computerHistory.history.length,
            sources: [...new Set(computerHistory.history.map((entry) => entry.source))],
        });

        const productPages = [
            ["nav-playbooks", "view-playbooks"], ["nav-artifacts", "view-artifacts"], ["nav-computer-history", "view-computer-history"],
            ["nav-skills", "view-skills"], ["nav-team-packs", "view-team-packs"], ["nav-channels", "view-channels"],
        ];
        for (const [navId, viewId] of productPages) {
            await renderer(`document.getElementById(${JSON.stringify(navId)})?.click(); true`);
            await waitFor(`${viewId} reachable`, async () => await renderer(`!document.getElementById(${JSON.stringify(viewId)})?.classList.contains("hidden")`), 15_000);
        }
        check("P0_PRODUCT_PAGES_REACHABLE", true, productPages.map(([, viewId]) => viewId));
        await renderer("document.getElementById('nav-channels')?.click(); true");
        await waitFor("unread channel filter", async () => {
            await renderer("(()=>{ const filter=document.getElementById('product-channel-filter-page'); if (filter) { filter.value='unread'; filter.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()");
            return await renderer("document.getElementById('product-channels-page')?.innerText.includes('P0 Work Room Updated')");
        }, 15_000);
        const quickSwitchValue = await renderer(`(()=>{ const select=document.getElementById('product-channel-switch-page'); const option=[...select.options].find((entry)=>entry.textContent.includes('P0 Work Room Updated')); if (!option) return undefined; select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return option.value; })()`);
        await waitFor("channel quick switch", async () => await renderer(`document.getElementById('conversation-title')?.textContent === "P0 Work Room Updated"`), 15_000);
        check("P0_CHANNEL_UNREAD_AND_QUICK_SWITCH", Boolean(quickSwitchValue), { conversationId: quickSwitchValue });
        await renderer("document.getElementById('nav-artifacts')?.click(); true");
        await waitFor("artifact page after source navigation", async () => await renderer("!document.getElementById('view-artifacts')?.classList.contains('hidden')"), 15_000);
        const artifactButtons = await renderer("[...document.querySelectorAll('#product-artifacts-page button')].map((button)=>button.textContent)");
        check("P0_ARTIFACT_UI_ACTIONS", ["Preview / 预览", "Open / 打开", "Reveal / 显示", "History / 历史", "Go to conversation / 前往会话"].every((label) => artifactButtons.includes(label)), artifactButtons);
        await renderer("[...document.querySelectorAll('#product-artifacts-page button')].find((button) => button.textContent === 'Go to conversation / 前往会话')?.click(); true");
        await waitFor("artifact source conversation", async () => await renderer("document.getElementById('conversation-title')?.textContent === 'Project Channel'"), 15_000);
        check("P0_ARTIFACT_SOURCE_CONVERSATION", true, await renderer("document.getElementById('conversation-title')?.textContent"));

        const externalSession = await getHost().runtime.operatorSessions.issue({ ttlMs: 60_000, label: "software-team-p0-canary" });
        try {
            const externalBase = `http://127.0.0.1:${handshake.externalTeamControl.port}/mcp/v1`;
            const externalRpc = async (name, args = {}) => {
                const response = await fetch(externalBase, { method: "POST", headers: { authorization: `Bearer ${externalSession.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: `p0-${name}`, method: "tools/call", params: { name, arguments: args } }) });
                const body = await response.json();
                if (body.error) throw new Error(body.error.message);
                return body.result.structuredContent;
            };
            const externalTools = await externalRpc("listTeams");
            const externalCoworkers = await externalRpc("listCoworkers");
            const externalChannels = await externalRpc("listChannels", { teamId: team.id, includeArchived: true });
            const externalConversation = await externalRpc("getConversation", { teamId: team.id, channelId: channel.id });
            const externalSkills = await externalRpc("listSkills", { includeArchived: true });
            const externalRoutines = await externalRpc("listRoutines");
            const externalAttention = await externalRpc("getAttention");
            const advertised = handshake.externalTeamControl.methods;
            check("P0_EXTERNAL_CONTROL_SURFACE", ["listTeams", "listCoworkers", "listChannels", "sendMessage", "getConversation", "listSkills", "listRoutines", "runRoutineNow", "getAttention", "submitOutcome", "getOutcomeStatus", "getArtifacts", "cancelOutcome", "requestTakeover"].every((method) => advertised.includes(method))
                && externalTools.teams?.some((entry) => entry.id === team.id)
                && externalCoworkers.coworkers?.length >= 3 && externalChannels.channels?.some((entry) => entry.id === channel.id)
                && externalConversation.messages?.length > 0 && Array.isArray(externalSkills.skills)
                && Array.isArray(externalRoutines.routines) && Array.isArray(externalAttention.jobs)
                && !containsAny({ externalTools, externalCoworkers, externalChannels, externalConversation, externalSkills, externalRoutines, externalAttention }, [dataDir, "cwd", "env", "provider", "session", "cookie", "secret", "token", "command", "policy"]), {
                methods: advertised,
                teams: externalTools.teams?.length ?? 0,
                channels: externalChannels.channels?.length ?? 0,
            });
            const externalDenied = await (async () => {
                try {
                    await externalRpc("getConversation", { teamId: team.id, channelId: channel.id, cwd: "C:\\private" });
                    return false;
                }
                catch {
                    return true;
                }
            })();
            check("P0_EXTERNAL_DENY_LIST", externalDenied);
        }
        finally {
            await getHost().runtime.operatorSessions.revoke(externalSession.token);
        }

        // P1 requirement audit: exercise the direct Bot-to-Bot collaboration
        // contract through the public renderer API. This deliberately uses a
        // fresh declarative pack so the chain is unambiguous: Chief -> Researcher
        // -> Reviewer (changes requested) -> Researcher -> Reviewer (approved)
        // -> Chief. The unrelated Software Team roster is not a participant.
        const p1Pack = {
            schema: "sovereignbot.desktop.team-pack.v1",
            id: "p1-grok-collaboration",
            name: "P1 Collaboration Team",
            description: "Requirement-level directed collaboration canary.",
            coworkers: [
                {
                    key: "chief",
                    name: "P1 Chief",
                    role: "Own the bounded outcome and coordinate the team.",
                    instructions: "Wake Researcher, preserve the attached artifact reference, and synthesize only after Reviewer approves.",
                    avatar: "✦",
                    modelBinding: { profile: "automatic" },
                },
                {
                    key: "researcher",
                    name: "P1 Researcher",
                    role: "Investigate the bounded question and prepare evidence.",
                    instructions: "Use the referenced artifact as evidence, then request Reviewer review.",
                    avatar: "⌕",
                    modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
                },
                {
                    key: "reviewer",
                    name: "P1 Reviewer",
                    role: "Review the Researcher result and return a strict decision.",
                    instructions: "Request one concrete revision on the first pass, then approve the revised result.",
                    avatar: "✓",
                    modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
                },
            ],
            channels: [{
                key: "project",
                name: "P1 Collaboration Room",
                kind: "project",
                instructions: "Chief scopes, Researcher investigates, Reviewer checks, and Chief synthesizes.",
                playbookId: "p1-collaboration",
            }],
            playbooks: [{
                id: "p1-collaboration",
                name: "P1 Collaboration",
                description: "Chief scopes -> Researcher investigates -> Reviewer reviews -> Chief synthesizes.",
                steps: ["chief", "researcher", "reviewer", "chief"],
            }],
        };
        const importedP1 = await renderer(`window.sovereignbot.teams.importPack(${JSON.stringify({ pack: p1Pack })})`);
        const p1Team = importedP1.team;
        const p1Channel = p1Team.channels[0];
        const [p1ChiefId, p1ResearcherId, p1ReviewerId] = p1Team.coworkerIds;
        check("P1_DIRECTED_TEAM_READY", importedP1.imported === true && p1Team.coworkerIds.length === 3
            && p1Channel?.name === "P1 Collaboration Room", {
            team: p1Team.name,
            coworkers: p1Team.coworkerIds.length,
            channel: p1Channel?.name,
        });
        await renderer(`openConversation(${JSON.stringify(p1Channel.conversationId)})`);
        await waitFor("P1 Collaboration Room visible", async () => await renderer(`document.getElementById("conversation-title")?.textContent === ${JSON.stringify(p1Channel.name)}`), 30_000);

        const staleArtifactRejected = await expectRendererReject(`window.sovereignbot.conversations.send(${JSON.stringify({
            conversationId: p1Channel.conversationId,
            text: "P1 stale artifact reference must be rejected.",
            artifactIds: [artifact.id],
            clientMessageId: "p1-stale-artifact",
        })})`);
        check("P1_STALE_ARTIFACT_REFERENCE_REJECTED", staleArtifactRejected, { referencedArtifact: artifact?.id, sourceConversation: channel.conversationId, targetConversation: p1Channel.conversationId });

        await renderer(`window.sovereignbot.conversations.send(${JSON.stringify({
            conversationId: p1Channel.conversationId,
            text: "P1_COLLABORATION: Chief wake Researcher with the attached artifact reference, ask Researcher to request Reviewer review, and return an approved final outcome.",
            clientMessageId: "p1-collaboration-positive",
        })})`);
        const p1Finished = await waitFor("P1 directed collaboration completion", async () => {
            const teamState = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(p1Team.id)} })`);
            const conversation = await renderer(`window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(p1Channel.conversationId)} })`);
            const activity = await renderer(`window.sovereignbot.teams.activity({ conversationId: ${JSON.stringify(p1Channel.conversationId)}, limit: 40 })`);
            return teamState?.flow?.stage === "complete" && conversation.messages.some((entry) => entry.text.includes("P1 Chief joined"))
                ? { team: teamState, conversation, activity }
                : false;
        }, 90_000);
        const p1Messages = p1Finished.conversation.messages;
        const p1SenderIds = [...new Set(p1Messages.map((entry) => entry.senderId))];
        const p1AllowedSenders = new Set(["user", p1ChiefId, p1ResearcherId, p1ReviewerId]);
        const p1BotMessages = p1Messages.filter((entry) => entry.senderId !== "user");
        const p1ChiefReply = p1BotMessages.find((entry) => entry.senderId === p1ChiefId && entry.text.includes("P1 Chief woke"));
        const p1ResearcherReply = p1BotMessages.find((entry) => entry.senderId === p1ResearcherId && entry.text.includes("P1 Researcher reply"));
        const p1ReviewMessages = p1BotMessages.filter((entry) => entry.senderId === p1ReviewerId);
        const p1FinalChief = p1BotMessages.find((entry) => entry.senderId === p1ChiefId && entry.text.includes("P1 Chief joined"));
        const p1Labels = new Set((p1Finished.activity?.events ?? []).map((entry) => entry.label));
        const p1Directed = p1ChiefReply?.mentions?.length === 1 && p1ChiefReply.mentions[0] === p1ResearcherId
            && p1ResearcherReply?.mentions?.length === 1 && p1ResearcherReply.mentions[0] === p1ReviewerId
            && p1BotMessages.every((entry) => !entry.mentions?.includes("everyone"))
            && p1BotMessages.every((entry) => entry.replyTo && p1Messages.some((candidate) => candidate.id === entry.replyTo))
            && p1ChiefReply.artifactIds?.length > 0;
        const p1RevisionAndApproval = p1ReviewMessages.length >= 2
            && p1ReviewMessages.some((entry) => entry.text.includes("requested changes"))
            && p1ReviewMessages.some((entry) => entry.text.includes("approved"));
        check("P1_DIRECTED_HANDOFF_REVIEW_CHAIN", p1Finished.team.flow.stage === "complete"
            && p1Finished.team.flow.status === "available" && p1Finished.team.flow.currentOwnerId === undefined
            && p1SenderIds.every((id) => p1AllowedSenders.has(id)) && p1Directed && p1RevisionAndApproval
            && Boolean(p1FinalChief) && p1Messages.some((entry) => entry.text.includes("P1_ARTIFACT_REFERENCE_RECEIVED(fake)")), {
            senderIds: p1SenderIds,
            messageCount: p1Messages.length,
            reviewCount: p1ReviewMessages.length,
            stage: p1Finished.team.flow.stage,
            status: p1Finished.team.flow.status,
            currentOwnerId: p1Finished.team.flow.currentOwnerId,
        });
        check("P1_ACTIVITY_AND_SAFE_PROJECTION", ["Handoff requested", "Review requested", "Changes requested", "Approved", "Completed"].every((label) => p1Labels.has(label))
            && !containsAny({ team: p1Finished.team, conversation: p1Finished.conversation, activity: p1Finished.activity }, [dataDir, "providerSession", "cwd", "runId", "requestId", "operationId", "operationToken"]), {
            labels: [...p1Labels],
            forbidden: containsAny({ team: p1Finished.team, conversation: p1Finished.conversation, activity: p1Finished.activity }, [dataDir, "providerSession", "cwd", "runId", "requestId", "operationId", "operationToken"]) ?? null,
        });
        if (p1Finished.team.flow.routingDecision !== undefined) {
            check("P1_ROUTER_DECISION_SAFE_SHAPE", Object.keys(p1Finished.team.flow.routingDecision).sort().join(",") === "boundedTask,handoffType,reason,targetCoworkerId", p1Finished.team.flow.routingDecision);
        }
        result.screenshots.push(await capture("p1-directed-collaboration.png"));

        // Inactive targets fail closed through the same public send path. The
        // archived Researcher must receive no work and the room must surface
        // Attention without exposing provider/runtime internals.
        await renderer(`window.sovereignbot.coworkers.archive(${JSON.stringify({ coworkerId: p1ResearcherId })})`);
        await renderer(`window.sovereignbot.conversations.send(${JSON.stringify({
            conversationId: p1Channel.conversationId,
            text: "P1_COLLABORATION inactive-target: route this bounded request to Researcher.",
            mentions: [p1ResearcherId],
            clientMessageId: "p1-inactive-target",
        })})`);
        const p1Attention = await waitFor("P1 inactive target attention", async () => {
            const teamState = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(p1Team.id)} })`);
            const conversation = await renderer(`window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(p1Channel.conversationId)} })`);
            const activity = await renderer(`window.sovereignbot.teams.activity({ conversationId: ${JSON.stringify(p1Channel.conversationId)}, limit: 12 })`);
            return teamState?.flow?.status === "needs-attention" && activity?.events?.some((entry) => entry.label === "Attention")
                ? { team: teamState, conversation, activity }
                : false;
        }, 30_000);
        const inactiveMessageIndex = p1Attention.conversation.messages.findIndex((entry) => entry.clientMessageId === "p1-inactive-target");
        const inactiveBotReply = p1Attention.conversation.messages.slice(Math.max(0, inactiveMessageIndex)).some((entry) => entry.senderId === p1ResearcherId && entry.text.includes("P1 Researcher reply"));
        check("P1_INACTIVE_TARGET_FAILS_CLOSED", !inactiveBotReply && p1Attention.team.flow.status === "needs-attention"
            && p1Attention.activity.events.some((entry) => entry.label === "Attention")
            && !containsAny(p1Attention, [dataDir, "providerSession", "cwd", "session", "token"]), {
            status: p1Attention.team.flow.status,
            attention: p1Attention.activity.events.some((entry) => entry.label === "Attention"),
            researcherReplied: inactiveBotReply,
        });
        await renderer(`window.sovereignbot.coworkers.restore(${JSON.stringify({ coworkerId: p1ResearcherId })})`);

        // Exercise the same public product path for a four-coworker team. The pack is
        // imported through the renderer so Electron IPC, TeamService's governed
        // workspace provisioning, runtime refresh, and the normal UI projection all
        // participate in this canary.
        const recipe = await renderer("window.sovereignbot.teams.exportPackRecipe({ packId: 'software-team' })");
        const fanoutPack = {
            ...recipe,
            id: "fanout-canary-pack",
            name: "Fanout Canary Team",
            description: "Four-coworker parallel delivery canary.",
            coworkers: [
                recipe.coworkers[0],
                recipe.coworkers[1],
                {
                    key: "researcher",
                    name: "Researcher",
                    role: "Research the bounded acceptance criteria independently.",
                    instructions: "Work only on the bounded research task and return a concise evidence note.",
                    avatar: "⌕",
                    // Reuse the Researcher that is already bound in the fresh
                    // runtime roster; importing a new binding during active work
                    // is intentionally rejected by RuntimeHost.
                    modelBinding: { profile: "automatic" },
                },
                recipe.coworkers.at(-1),
            ],
            channels: [{
                ...recipe.channels[0],
                name: "Fanout Room",
                instructions: "Chief coordinates two independent specialists, Reviewer checks both, and Chief joins the result.",
                playbookId: "fanout-delivery",
            }],
            playbooks: [{
                ...recipe.playbooks[0],
                id: "fanout-delivery",
                name: "Parallel Delivery",
                description: "Chief coordinates → two specialists work independently → Reviewer checks → Chief joins.",
                steps: ["chief", "coding-lead", "researcher", "reviewer", "chief"],
            }],
        };
        await renderer(`(()=>{
            const area = document.getElementById('team-pack-json');
            area.value = ${JSON.stringify(JSON.stringify(fanoutPack))};
            document.getElementById('team-pack-form').requestSubmit();
            return true;
        })()`);
        const importedFanout = await waitFor("four-coworker fanout team import", async () => {
            const listed = await renderer("window.sovereignbot.teams.list({})");
            const candidate = listed?.teams?.find((entry) => entry.name === "Fanout Canary Team");
            return candidate?.coworkers?.length === 4 && candidate.channels?.[0] ? candidate : false;
        }, 30_000);
        const fanoutChannel = importedFanout.channels[0];
        const fanoutNames = importedFanout.coworkers.map((entry) => entry.name);
        check("FANOUT_ELECTRON_TEAM_READY", fanoutNames.join("|") === "Chief of Staff|Coding Lead|Researcher|Reviewer", { coworkerCount: fanoutNames.length, coworkers: fanoutNames });
        await waitFor("Fanout Room visible", async () => await renderer(`document.getElementById("conversation-title")?.textContent === ${JSON.stringify(fanoutChannel.name)}`), 30_000);

        await renderer(`window.sovereignbot.conversations.send(${JSON.stringify({
            conversationId: fanoutChannel.conversationId,
            text: "FANOUT_CANARY: run two independent bounded subtasks, review both results, and join the completed outcome.",
            clientMessageId: "canary-fanout-positive",
        })})`);
        await waitFor("positive fanout message visible", async () => await renderer("document.getElementById('conversation-messages')?.innerText.includes('FANOUT_CANARY')"), 30_000);
        await renderer("document.getElementById('open-details')?.click(); true");
        await waitFor("fanout details panel open", async () => await renderer("!document.getElementById('details-panel')?.classList.contains('hidden')"), 10_000);
        const fanoutRunning = await waitFor("parallel fanout work", async () => {
            const team = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(importedFanout.id)} })`);
            const conversation = await renderer(`window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(fanoutChannel.conversationId)} })`);
            const activity = await renderer(`window.sovereignbot.teams.activity({ conversationId: ${JSON.stringify(fanoutChannel.conversationId)}, limit: 40 })`);
            const fanout = team?.flow?.activeFanout;
            return fanout && fanout.children?.length === 2 && ["running", "review_requested", "reviewing", "join_requested", "joining"].includes(fanout.state)
                ? { team, conversation, activity, body: await renderer("document.body.innerText"), details: await renderer("({ hidden: document.getElementById('details-panel')?.classList.contains('hidden'), rect: (()=>{ const r = document.getElementById('details-panel')?.getBoundingClientRect(); return r ? { width: r.width, height: r.height } : undefined; })(), text: document.getElementById('details-panel')?.innerText || '' })") }
                : false;
        }, 45_000);
        const activeFanout = fanoutRunning.team.flow.activeFanout;
        check("FANOUT_PARALLEL_WORKING", activeFanout?.state && activeFanout.children?.length === 2
            && activeFanout.owner === "Chief of Staff" && activeFanout.reviewer === "Reviewer"
            && activeFanout.children.every((entry) => ["running", "completed"].includes(entry.status))
            && activeFanout.children.some((entry) => entry.coworker === "Coding Lead")
            && activeFanout.children.some((entry) => entry.coworker === "Researcher"), {
            state: activeFanout?.state,
            childCount: activeFanout?.children?.length ?? 0,
            owner: activeFanout?.owner,
            reviewer: activeFanout?.reviewer,
        });
        const fanoutUiBody = `${String(fanoutRunning.body ?? "")}\n${String(fanoutRunning.details?.text ?? "")}`;
        check("FANOUT_UI_PROJECTION", fanoutRunning.details?.hidden === false && (fanoutRunning.details?.rect?.width ?? 0) > 0
            && fanoutUiBody.includes("Fanout Canary Team") && fanoutUiBody.includes("Chief of Staff")
            && fanoutUiBody.includes("Coding Lead") && fanoutUiBody.includes("Researcher") && fanoutUiBody.includes("Reviewer")
            && (fanoutUiBody.includes("Parallel work") || fanoutUiBody.includes("specialists complete") || fanoutUiBody.includes("Reviewing")), {
            rosterCount: fanoutNames.length,
            panelHidden: fanoutRunning.details?.hidden,
            panelWidth: fanoutRunning.details?.rect?.width,
            hasParallelStatus: fanoutUiBody.includes("Parallel work") || fanoutUiBody.includes("specialists complete") || fanoutUiBody.includes("Reviewing"),
        });
        result.screenshots.push(await capture("fanout-parallel.png"));

        const fanoutFinished = await waitFor("fanout review and join", async () => {
            const team = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(importedFanout.id)} })`);
            const conversation = await renderer(`window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(fanoutChannel.conversationId)} })`);
            const activity = await renderer(`window.sovereignbot.teams.activity({ conversationId: ${JSON.stringify(fanoutChannel.conversationId)}, limit: 40 })`);
            const artifacts = await renderer(`window.sovereignbot.artifacts.list(${JSON.stringify({ conversationId: fanoutChannel.conversationId, limit: 20 })})`);
            return team?.flow?.stage === "complete" && conversation.messages.some((entry) => entry.text.includes("FANOUT JOIN RESULT(fake)"))
                ? { team, conversation, activity, artifacts, body: await renderer("document.body.innerText") }
                : false;
        }, 90_000);
        const fanoutLabels = new Set((fanoutFinished.activity?.events ?? []).map((entry) => entry.label));
        const requiredFanoutLabels = ["Parallel work", "Specialist working", "Specialist submitted", "Review requested", "Reviewing", "Approved", "Joining results", "Completed"];
        check("FANOUT_ACTIVITY_PROJECTION", requiredFanoutLabels.every((label) => fanoutLabels.has(label))
            && fanoutFinished.activity?.events?.some((entry) => entry.owner === "Chief of Staff")
            && fanoutFinished.activity?.events?.some((entry) => entry.targetCoworker === "Coding Lead")
            && fanoutFinished.activity?.events?.some((entry) => entry.targetCoworker === "Researcher"), {
            labels: [...fanoutLabels].filter((label) => requiredFanoutLabels.includes(label)),
            eventCount: fanoutFinished.activity?.events?.length ?? 0,
        });
        check("FANOUT_JOIN_COMPLETED", fanoutFinished.team.flow.stage === "complete"
            && fanoutFinished.team.flow.status === "available"
            && fanoutFinished.conversation.messages.some((entry) => entry.senderId === importedFanout.coworkerIds[0] && entry.text.includes("FANOUT JOIN RESULT(fake)"))
            && fanoutFinished.artifacts?.artifacts?.length > 0, {
            stage: fanoutFinished.team.flow.stage,
            artifactCount: fanoutFinished.artifacts?.artifacts?.length ?? 0,
        });
        const fanoutPublicSurface = { flow: fanoutFinished.team.flow, activity: fanoutFinished.activity, conversation: fanoutFinished.conversation, body: fanoutFinished.body };
        const forbiddenFanoutInternals = [dataDir, "fanoutId", "sourceMessageId", "ownerMessageId", "reviewMessageId", "taskId", "runId", "requestId", "operationId", "operationToken", "providerSession", "worktree", "batchId", "childId"];
        check("FANOUT_PUBLIC_PROJECTION_REDACTED", !containsAny(fanoutPublicSurface, forbiddenFanoutInternals), { forbidden: containsAny(fanoutPublicSurface, forbiddenFanoutInternals) ?? null });
        result.screenshots.push(await capture("fanout-completed.png"));
        const positiveArtifactCount = fanoutFinished.artifacts?.artifacts?.length ?? 0;
        const positiveJoinCount = fanoutFinished.conversation.messages.filter((entry) => entry.text.includes("FANOUT JOIN RESULT(fake)")).length;

        // Negative path: use the real public stop IPC while both private child
        // processes are still running. The stopped run must surface Attention and
        // leave no published ArtifactStore result or join message behind.
        await renderer(`window.sovereignbot.conversations.send(${JSON.stringify({
            conversationId: fanoutChannel.conversationId,
            text: "FANOUT_CANARY negative-stop: stop this parallel run before any child submits.",
            clientMessageId: "canary-fanout-negative",
        })})`);
        await waitFor("negative fanout message visible", async () => await renderer("document.getElementById('conversation-messages')?.innerText.includes('negative-stop')"), 30_000);
        const negativeRunning = await waitFor("negative fanout child work", async () => {
            const team = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(importedFanout.id)} })`);
            return team?.flow?.activeFanout?.state === "running" && team.flow.activeFanout.children?.some((entry) => entry.status === "running") ? team : false;
        }, 45_000);
        const stopResult = await renderer(`(async()=>{
            const result = await window.sovereignbot.conversations.stop(${JSON.stringify({ conversationId: fanoutChannel.conversationId })});
            await openConversation(${JSON.stringify(fanoutChannel.conversationId)});
            return result;
        })()`);
        await renderer("document.getElementById('open-details')?.click(); true");
        await waitFor("stopped fanout details panel open", async () => await renderer("!document.getElementById('details-panel')?.classList.contains('hidden')"), 10_000);
        const negativeStopped = await waitFor("stopped fanout attention state", async () => {
            const team = await renderer(`window.sovereignbot.teams.get({ teamId: ${JSON.stringify(importedFanout.id)} })`);
            const conversation = await renderer(`window.sovereignbot.conversations.get({ conversationId: ${JSON.stringify(fanoutChannel.conversationId)} })`);
            const artifacts = await renderer(`window.sovereignbot.artifacts.list(${JSON.stringify({ conversationId: fanoutChannel.conversationId, limit: 20 })})`);
            const activity = await renderer(`window.sovereignbot.teams.activity({ conversationId: ${JSON.stringify(fanoutChannel.conversationId)}, limit: 12 })`);
            const details = await renderer("document.getElementById('details-panel')?.innerText || ''");
            return team?.flow?.status === "stopped" && team.flow.activeFanout?.state === "stopped" && String(details).includes("Attention")
                ? { team, conversation, artifacts, activity, body: await renderer("document.body.innerText"), details }
                : false;
        }, 30_000);
        check("FANOUT_NEGATIVE_STOP_FAILS_CLOSED", negativeRunning.flow.activeFanout.children.some((entry) => entry.status === "running")
            && stopResult && negativeStopped.team.flow.status === "stopped" && negativeStopped.team.flow.activeFanout?.state === "stopped"
            && negativeStopped.activity?.events?.some((entry) => entry.label === "Attention"), {
            status: negativeStopped.team.flow.status,
            fanoutState: negativeStopped.team.flow.activeFanout?.state,
            attention: negativeStopped.activity?.events?.some((entry) => entry.label === "Attention") === true,
        });
        const negativeJoinCount = negativeStopped.conversation.messages.filter((entry) => entry.text.includes("FANOUT JOIN RESULT(fake)")).length;
        check("FANOUT_NEGATIVE_NO_ARTIFACT_OR_JOIN", (negativeStopped.artifacts?.artifacts?.length ?? 0) === positiveArtifactCount
            && negativeJoinCount === positiveJoinCount, {
            artifactCount: negativeStopped.artifacts?.artifacts?.length ?? 0,
            baselineArtifactCount: positiveArtifactCount,
            joinCount: negativeJoinCount,
            baselineJoinCount: positiveJoinCount,
        });
        const negativeAttentionVisible = `${String(negativeStopped.body ?? "")}\n${String(negativeStopped.details ?? "")}`.includes("Attention")
            || negativeStopped.activity?.events?.some((entry) => entry.label === "Attention");
        check("FANOUT_NEGATIVE_UI_ATTENTION", negativeAttentionVisible
            && !containsAny({ team: negativeStopped.team.flow, activity: negativeStopped.activity, conversation: negativeStopped.conversation }, forbiddenFanoutInternals), {
            status: negativeStopped.team.flow.status,
            attentionVisible: negativeAttentionVisible,
            forbidden: containsAny({ team: negativeStopped.team.flow, activity: negativeStopped.activity, conversation: negativeStopped.conversation }, forbiddenFanoutInternals) ?? null,
        });
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
