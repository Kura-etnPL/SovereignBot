import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const PRODUCT_SURFACES_SCHEMA = "sovereignbot.desktop.product-surfaces.v1";
const PLAYBOOK_SCHEMA = "sovereignbot.desktop.playbook.v1";
const PACK_SCHEMA = "sovereignbot.desktop.team-pack.v1";
const MAX_PLAYBOOKS = 256;
const MAX_PACK_RECIPES = 128;
const MAX_PLAYBOOK_STAGES = 8;
const MAX_PLAYBOOK_REVIEW_POINTS = 8;
const MAX_PLAYBOOK_RECOMMENDED_ROLES = 8;
const MAX_PLAYBOOK_RECOMMENDED_SKILLS = 16;

function clone(value) { return structuredClone(value); }
function text(value, label, max, required = false) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${label} is required`);
        return "";
    }
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const out = value.trim();
    if (required && !out) throw new Error(`${label} is required`);
    if (out.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return out;
}
function id(value, label) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} must be an identifier`);
    return value;
}
function makeId(prefix) { return `${prefix}_${randomBytes(8).toString("hex")}`; }

function normalizedIdList(value, label, max) {
    if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} identifiers`);
    return [...new Set(value.map((entry) => id(entry, label)))];
}

function normalizePlaybookSemantics(input) {
    const out = {};
    if (input.stages !== undefined) {
        if (!Array.isArray(input.stages) || input.stages.length > MAX_PLAYBOOK_STAGES) throw new Error("playbook stages must be an array of at most 8 stages");
        out.stages = input.stages.map((stage) => {
            if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error("playbook stage must be an object");
            const allowed = new Set(["id", "name", "instructions", "expectedOutput", "recommendedCoworkerRole", "recommendedSkillIds"]);
            for (const key of Object.keys(stage)) if (!allowed.has(key)) throw new Error(`playbook stage field is not allowed: ${key}`);
            return {
                id: id(stage.id, "playbook stage id"),
                name: text(stage.name, "playbook stage name", 120, true),
                instructions: text(stage.instructions ?? "", "playbook stage instructions", 2_000),
                ...(stage.expectedOutput === undefined ? {} : { expectedOutput: text(stage.expectedOutput, "playbook stage expectedOutput", 500) }),
                ...(stage.recommendedCoworkerRole === undefined ? {} : { recommendedCoworkerRole: text(stage.recommendedCoworkerRole, "playbook stage recommendedCoworkerRole", 120) }),
                ...(stage.recommendedSkillIds === undefined ? {} : { recommendedSkillIds: normalizedIdList(stage.recommendedSkillIds, "playbook stage recommendedSkillId", 8) }),
            };
        });
    }
    if (input.reviewPoints !== undefined) {
        if (!Array.isArray(input.reviewPoints) || input.reviewPoints.length > MAX_PLAYBOOK_REVIEW_POINTS) throw new Error("playbook reviewPoints must be an array of at most 8 review points");
        out.reviewPoints = input.reviewPoints.map((point) => {
            if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("playbook review point must be an object");
            const allowed = new Set(["id", "name", "instructions", "recommendedCoworkerRole", "recommendedSkillIds"]);
            for (const key of Object.keys(point)) if (!allowed.has(key)) throw new Error(`playbook review point field is not allowed: ${key}`);
            return {
                id: id(point.id, "playbook review point id"),
                name: text(point.name, "playbook review point name", 120, true),
                instructions: text(point.instructions ?? "", "playbook review point instructions", 2_000),
                ...(point.recommendedCoworkerRole === undefined ? {} : { recommendedCoworkerRole: text(point.recommendedCoworkerRole, "playbook review point recommendedCoworkerRole", 120) }),
                ...(point.recommendedSkillIds === undefined ? {} : { recommendedSkillIds: normalizedIdList(point.recommendedSkillIds, "playbook review point recommendedSkillId", 8) }),
            };
        });
    }
    if (input.expectedOutput !== undefined) out.expectedOutput = text(input.expectedOutput, "playbook expectedOutput", 500);
    if (input.recommendedCoworkerRoles !== undefined) {
        if (!Array.isArray(input.recommendedCoworkerRoles) || input.recommendedCoworkerRoles.length > MAX_PLAYBOOK_RECOMMENDED_ROLES) throw new Error("playbook recommendedCoworkerRoles must contain at most 8 roles");
        out.recommendedCoworkerRoles = [...new Set(input.recommendedCoworkerRoles.map((role) => text(role, "playbook recommendedCoworkerRole", 120, true)))];
    }
    if (input.recommendedSkillIds !== undefined) out.recommendedSkillIds = normalizedIdList(input.recommendedSkillIds, "playbook recommendedSkillId", MAX_PLAYBOOK_RECOMMENDED_SKILLS);
    return out;
}

function normalizePlaybook(input, { requireSchema = false, generatedId } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("playbook must be an object");
    const allowed = new Set(["schema", "id", "name", "description", "steps", "stages", "reviewPoints", "expectedOutput", "recommendedCoworkerRoles", "recommendedSkillIds"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`playbook field is not allowed: ${key}`);
    if (requireSchema && input.schema !== PLAYBOOK_SCHEMA) throw new Error(`playbook schema must be ${PLAYBOOK_SCHEMA}`);
    const steps = input.steps;
    if (!Array.isArray(steps) || steps.length > 12) throw new Error("playbook steps must be an array of at most 12 identifiers");
    return {
        id: id(generatedId ?? input.id, "playbookId"),
        name: text(input.name, "playbook name", 120, true),
        description: text(input.description ?? "", "playbook description", 500),
        steps: steps.map((step) => id(step, "playbook step")),
        ...normalizePlaybookSemantics(input),
    };
}

function normalizePack(input, { generatedId } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("team pack must be an object");
    const out = clone(input);
    const topAllowed = new Set(["schema", "id", "name", "description", "coworkers", "channels", "playbooks"]);
    for (const key of Object.keys(out)) if (!topAllowed.has(key)) throw new Error(`team pack field is not allowed: ${key}`);
    out.schema = PACK_SCHEMA;
    out.id = id(generatedId ?? out.id, "packId");
    out.name = text(out.name, "team pack name", 120, true);
    out.description = text(out.description ?? "", "team pack description", 500);
    if (!Array.isArray(out.coworkers) || out.coworkers.length < 2 || out.coworkers.length > 8) throw new Error("team pack coworkers are invalid");
    if (!Array.isArray(out.channels) || out.channels.length < 1 || out.channels.length > 8) throw new Error("team pack channels are invalid");
    if (!Array.isArray(out.playbooks) || out.playbooks.length < 1 || out.playbooks.length > 8) throw new Error("team pack playbooks are invalid");
    out.coworkers = out.coworkers.map((entry) => {
        const allowed = new Set(["key", "name", "role", "instructions", "avatar", "modelBinding"]);
        for (const key of Object.keys(entry)) if (!allowed.has(key)) throw new Error(`team pack coworker field is not allowed: ${key}`);
        const modelBinding = entry.modelBinding;
        if (modelBinding !== undefined && (typeof modelBinding !== "object" || Array.isArray(modelBinding))) throw new Error("team pack modelBinding must be an object");
        if (modelBinding) for (const key of Object.keys(modelBinding)) if (!["profile", "provider", "model"].includes(key)) throw new Error(`team pack modelBinding field is not allowed: ${key}`);
        return {
        key: id(entry.key, "coworker key"), name: text(entry.name, "coworker name", 80, true),
        role: text(entry.role, "coworker role", 120, true), instructions: text(entry.instructions, "coworker instructions", 12_000, true),
        ...(entry.avatar ? { avatar: text(entry.avatar, "coworker avatar", 120) } : {}),
        modelBinding: modelBinding
            ? { profile: ["automatic", "efficient", "deep", "economy", "custom"].includes(modelBinding.profile) ? modelBinding.profile : "automatic", ...(modelBinding.provider ? { provider: id(modelBinding.provider, "provider") } : {}), ...(modelBinding.model ? { model: id(modelBinding.model, "model") } : {}) }
            : { profile: "automatic" },
        };
    });
    out.channels = out.channels.map((entry) => { const allowed = new Set(["key", "name", "kind", "instructions", "playbookId"]); for (const key of Object.keys(entry)) if (!allowed.has(key)) throw new Error(`team pack channel field is not allowed: ${key}`); return { key: id(entry.key, "channel key"), name: text(entry.name, "channel name", 120, true), kind: ["work", "personal", "project"].includes(entry.kind) ? entry.kind : "project", instructions: text(entry.instructions ?? "", "channel instructions", 12_000), playbookId: id(entry.playbookId, "channel playbookId") }; });
    out.playbooks = out.playbooks.map((entry) => normalizePlaybook(entry));
    return out;
}

function safeHistoryText(value, max = 180) {
    const out = text(value === undefined || value === null ? "" : String(value), "history text", max)
        .replace(/[A-Za-z]:[\\/][^\s"'<>]*/g, "[redacted-path]")
        .replace(/\\\\[^\s"'<>]+/g, "[redacted-path]")
        .replace(/(?:^|\s)\/(?:Users|home|tmp|var|private|workspace|worktrees?)[^\s"'<>]*/gi, "$1[redacted-path]")
        .replace(/file:\/\/[^\s"'<>]+/gi, "[redacted-path]")
        .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
            try { return new URL(value).origin; }
            catch { return "[redacted-url]"; }
        })
        .replace(/(?:bearer\s+|authorization\s*[:=]\s*|api[-_]?key\s*[:=]\s*|token|secret|password|cookie|session|credential)\s*[:=]?\s*[^\s]+/gi, "[redacted]");
    return out;
}

function safeOpaqueId(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

export function createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime, getRuntime, now = () => new Date().toISOString() } = {}) {
    if (!dataDir || !teamService || !coworkerStore || !artifactStore || !runtime) throw new Error("product surface service requires existing stores and runtime");
    const resolveRuntime = typeof getRuntime === "function" ? getRuntime : () => runtime;
    const persistPath = join(dataDir, "desktop-state", "product-surfaces.json");
    const loaded = loadJsonState(persistPath, null);
    const state = loaded?.schema === PRODUCT_SURFACES_SCHEMA ? {
        playbooks: Array.isArray(loaded.playbooks) ? loaded.playbooks : [],
        packRecipes: Array.isArray(loaded.packRecipes) ? loaded.packRecipes : [],
    } : { playbooks: [], packRecipes: [] };
    state.playbooks = state.playbooks.filter((entry) => {
        try {
            const { state: entryState, createdAt, updatedAt, ...definition } = entry;
            normalizePlaybook(definition);
            return ["active", "archived"].includes(entryState) && typeof createdAt === "string" && typeof updatedAt === "string";
        } catch { return false; }
    }).slice(-MAX_PLAYBOOKS);
    state.packRecipes = state.packRecipes.filter((entry) => { try { normalizePack(entry.recipe); return true; } catch { return false; } }).slice(-MAX_PACK_RECIPES);
    // Existing TeamService playbooks are first-class library entries too.  Seed only
    // missing projections; the embedded TeamService definitions remain authoritative
    // for execution and channel binding.
    for (const team of teamService.list().teams) for (const playbook of team.playbooks ?? []) {
        if (state.playbooks.some((entry) => entry.id === playbook.id)) continue;
        try { state.playbooks.push({ ...normalizePlaybook(playbook), state: "active", createdAt: team.createdAt, updatedAt: team.updatedAt }); } catch {}
    }
    state.playbooks = state.playbooks.slice(-MAX_PLAYBOOKS);
    function save() { saveJsonState(persistPath, { schema: PRODUCT_SURFACES_SCHEMA, ...state }); }
    function playbookById(playbookId) { const entry = state.playbooks.find((item) => item.id === String(playbookId)); if (!entry) throw new Error(`unknown playbook id: ${playbookId}`); return entry; }
    function publicPlaybook(entry) {
        const teams = teamService.list().teams.filter((team) => team.playbooks?.some((item) => item.id === entry.id)).map((team) => ({ id: team.id, name: team.name }));
        const channels = teamService.list().teams.flatMap((team) => (team.channels ?? []).filter((channel) => channel.playbookId === entry.id).map((channel) => ({ id: channel.id, name: channel.name, teamId: team.id, teamName: team.name })));
        return { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: [...entry.steps], ...normalizePlaybookSemantics(entry), state: entry.state, createdAt: entry.createdAt, updatedAt: entry.updatedAt, assignedTeams: teams, assignedChannels: channels };
    }
    function listPlaybooks({ includeArchived = false } = {}) {
        return { schema: PLAYBOOK_SCHEMA, playbooks: state.playbooks.filter((entry) => includeArchived || entry.state !== "archived").map(publicPlaybook) };
    }
    function createPlaybook(input) {
        if (state.playbooks.length >= MAX_PLAYBOOKS) throw new Error("playbook library limit reached");
        const timestamp = now(); const entry = { ...normalizePlaybook(input, { generatedId: makeId("playbook") }), state: "active", createdAt: timestamp, updatedAt: timestamp };
        state.playbooks.push(entry); save(); return publicPlaybook(entry);
    }
    function updatePlaybook(playbookId, patch) {
        const entry = playbookById(playbookId); if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("playbook patch must be an object");
        const semanticFields = ["stages", "reviewPoints", "expectedOutput", "recommendedCoworkerRoles", "recommendedSkillIds"];
        const next = normalizePlaybook({ id: entry.id, name: patch.name ?? entry.name, description: patch.description ?? entry.description, steps: patch.steps ?? entry.steps, ...Object.fromEntries(semanticFields.map((field) => [field, Object.hasOwn(patch, field) ? patch[field] : entry[field]]).filter(([, value]) => value !== undefined)) });
        const assignedTeams = teamService.list().teams.filter((team) => team.playbooks?.some((item) => item.id === entry.id));
        if (typeof teamService.updatePlaybook !== "function" && assignedTeams.length)
            throw new Error("assigned playbook updates are unavailable");
        for (const team of assignedTeams)
            teamService.updatePlaybook(team.id, entry.id, { name: next.name, description: next.description, steps: next.steps, ...normalizePlaybookSemantics(next) });
        Object.assign(entry, next, { updatedAt: now() }); save(); return publicPlaybook(entry);
    }
    function setPlaybookState(playbookId, value) { const entry = playbookById(playbookId); entry.state = value; entry.updatedAt = now(); save(); return publicPlaybook(entry); }
    function duplicatePlaybook(playbookId) { const entry = playbookById(playbookId); return createPlaybook({ name: `${entry.name} copy`, description: entry.description, steps: entry.steps, ...normalizePlaybookSemantics(entry) }); }
    function importPlaybook(input) {
        const normalized = normalizePlaybook(input, { requireSchema: true });
        const existing = state.playbooks.find((entry) => entry.id === normalized.id);
        if (existing) return { imported: false, playbook: publicPlaybook(existing) };
        const timestamp = now(); const entry = { ...normalized, state: "active", createdAt: timestamp, updatedAt: timestamp }; state.playbooks.push(entry); save(); return { imported: true, playbook: publicPlaybook(entry) };
    }
    function assignPlaybook(playbookId, { teamId, channelId } = {}) {
        const entry = playbookById(playbookId);
        if ((teamId === undefined) === (channelId === undefined)) throw new Error("assign a playbook to exactly one team or channel");
        if (teamId !== undefined) {
            const team = teamService.get(teamId);
            if (!team.playbooks.some((item) => item.id === entry.id)) teamService.importPlaybook(team.id, { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: entry.steps, ...normalizePlaybookSemantics(entry) });
        } else {
            const channel = teamService.getChannel(channelId);
            if (!teamService.get(channel.teamId).playbooks.some((item) => item.id === entry.id)) teamService.importPlaybook(channel.teamId, { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: entry.steps, ...normalizePlaybookSemantics(entry) });
            teamService.updateChannel(channel.id, { playbookId: entry.id });
        }
        return publicPlaybook(entry);
    }
    function exportPlaybook(playbookId) { const entry = playbookById(playbookId); return { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: [...entry.steps], ...normalizePlaybookSemantics(entry) }; }
    function artifactView(artifact, channels, { eventOnly = false } = {}) {
        const channel = channels.find((item) => item.conversationId === artifact.conversationId);
        const creator = artifact.createdByCoworkerId ? coworkerStore.get(artifact.createdByCoworkerId) : undefined;
        const view = {
            id: safeOpaqueId(artifact.id),
            title: safeHistoryText(artifact.title, 180),
            fileName: safeHistoryText(artifact.fileName, 180),
            mimeType: artifact.mimeType,
            size: artifact.size,
            createdAt: artifact.createdAt,
            version: Number.isInteger(artifact.version) ? artifact.version : undefined,
            artifactFamilyId: safeOpaqueId(artifact.artifactFamilyId ?? artifact.id),
            parentArtifactId: safeOpaqueId(artifact.parentArtifactId),
            creator: creator ? { id: safeOpaqueId(creator.id), name: safeHistoryText(creator.name, 120) } : undefined,
            coworkerId: safeOpaqueId(artifact.createdByCoworkerId),
            team: channel ? { id: safeOpaqueId(channel.teamId), name: safeHistoryText(channel.teamName, 120) } : undefined,
            channel: channel ? { id: safeOpaqueId(channel.id), name: safeHistoryText(channel.name, 120) } : undefined,
            conversationId: safeOpaqueId(artifact.conversationId),
            sourceMessageId: safeOpaqueId(artifact.sourceMessageId),
            archived: artifact.archived === true,
            archivedAt: typeof artifact.archivedAt === "string" ? artifact.archivedAt : undefined,
        };
        if (eventOnly) {
            return {
                event: artifact.parentArtifactId ? "restored" : "created",
                timestamp: artifact.createdAt,
                version: view.version,
                artifactId: view.id,
                parentArtifactId: safeOpaqueId(artifact.parentArtifactId),
                creator: view.creator,
            };
        }
        return view;
    }
    function artifactHub({ limit = 100, teamId, channelId, coworkerId, type, visibility = "active" } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("artifact hub limit must be 1..500");
        if (type !== undefined && (typeof type !== "string" || !type.trim() || type.length > 120)) throw new Error("artifact hub type must be a bounded string");
        if (!["active", "archived", "all"].includes(visibility)) throw new Error("artifact hub visibility must be active, archived, or all");
        const normalizedType = type?.trim();
        const teams = teamService.list().teams; const channels = teams.flatMap((team) => (team.channels ?? []).map((channel) => ({ ...channel, teamId: team.id, teamName: team.name })));
        const allowedConversationIds = new Set(channels.filter((channel) => (!teamId || channel.teamId === teamId) && (!channelId || channel.id === channelId)).map((channel) => channel.conversationId));
        const locationScoped = teamId !== undefined || channelId !== undefined;
        // Fetch the bounded store maximum before applying the location filter. A
        // recent unrelated artifact must not hide an older result from the selected
        // Team or Channel merely because the store sliced first.
        const latestByFamily = new Map();
        for (const artifact of artifactStore.list({ limit: 500, coworkerId, visibility }).artifacts) {
            const familyId = artifact.artifactFamilyId ?? artifact.id;
            const current = latestByFamily.get(familyId);
            if (!current || (Number.isInteger(artifact.version) ? artifact.version : 1) > (Number.isInteger(current.version) ? current.version : 1)) latestByFamily.set(familyId, artifact);
        }
        const result = [...latestByFamily.values()]
            .filter((artifact) => !locationScoped ? true : Boolean(artifact.conversationId) && allowedConversationIds.has(artifact.conversationId))
            .filter((artifact) => !normalizedType || artifact.mimeType === normalizedType)
            .slice(0, limit).map((artifact) => ({
                ...artifactView(artifact, channels),
                history: [artifactView(artifact, channels, { eventOnly: true })],
                status: artifact.archived ? "archived" : "available",
            }));
        return { artifacts: result };
    }
    function artifactHistory({ artifactId } = {}) {
        if (typeof artifactStore.history !== "function") return { artifacts: [] };
        const channels = teamService.list().teams.flatMap((team) => (team.channels ?? []).map((channel) => ({ ...channel, teamId: team.id, teamName: team.name })));
        return { artifacts: artifactStore.history(artifactId).history.map((artifact) => artifactView(artifact, channels)) };
    }
    async function computerHistory({ limit = 100 } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("computer history limit must be 1..500");
        const activeRuntime = resolveRuntime();
        if (!activeRuntime?.audit?.readAll) throw new Error("computer history audit is unavailable");
        const rows = await activeRuntime.audit.readAll(); const result = [];
        for (const row of rows.slice(-Math.min(500, Math.max(1, limit * 4))).reverse()) {
            const type = String(row?.type ?? "");
            if (!/(?:^|[._:-])(computer|takeover|task|job)(?:[._:-]|$)/i.test(type)) continue;
            // Secret, auth and continuity records are deliberately not activity
            // history. Do not make the decision from arbitrary values: only the
            // event name and a small data allowlist are used below.
            if (/secret|credential|auth|login|session|webdriver|continuity/i.test(type)) continue;
            const data = row?.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data : {};
            const status = data.ok === false || /failed|error|rejected|denied/i.test(type) ? "failed" : /attention|takeover|paused|help_requested/i.test(type) ? "attention" : /requested/i.test(type) ? "requested" : "completed";
            const source = /computer/i.test(type) ? "computer" : /takeover/i.test(type) ? "takeover" : /task|job/i.test(type) ? "task" : "audit";
            const activity = data.activity ?? data.operation ?? data.action ?? type;
            const summary = data.summary ?? data.intent ?? data.title ?? data.action ?? data.operation ?? type;
            const coworkerId = safeOpaqueId(data.coworkerId) ?? safeOpaqueId(data.agentId) ?? safeOpaqueId(row?.actor);
            result.push({ id: safeOpaqueId(row?.id) ?? `history-${result.length + 1}`, eventType: safeHistoryText(type, 100), source, activity: safeHistoryText(activity), coworkerId, summary: safeHistoryText(summary), app: data.app ? safeHistoryText(data.app, 80) : undefined, site: data.site ? safeHistoryText(data.site, 180) : undefined, timestamp: typeof row?.at === "string" ? row.at : undefined, status });
            if (result.length >= limit) break;
        }
        return { history: result };
    }
    function recipeFor(packId) { return state.packRecipes.find((entry) => entry.recipe.id === String(packId)); }
    function findInstalledTeam(packId) { return teamService.list().teams.find((team) => team.packId === String(packId)); }
    function sourceRecipe(packId) {
        const saved = recipeFor(packId);
        if (saved) return normalizePack(saved.recipe);
        if (typeof teamService.exportPackRecipe === "function") return normalizePack(teamService.exportPackRecipe(packId));
        const team = findInstalledTeam(packId);
        if (!team) throw new Error(`unknown team pack: ${packId}`);
        return normalizePack(teamService.exportPack(team.id));
    }
    function saveRecipe(recipe) {
        const current = recipeFor(recipe.id);
        if (current) {
            current.recipe = recipe;
            current.updatedAt = now();
        }
        else {
            if (state.packRecipes.length >= MAX_PACK_RECIPES) throw new Error(`team pack recipe limit reached (${MAX_PACK_RECIPES})`);
            state.packRecipes.push({ recipe, updatedAt: now() });
        }
        save();
        return clone(recipe);
    }
    function duplicatePack(packId) { const source = sourceRecipe(packId); return saveRecipe(normalizePack(source, { generatedId: `custom-pack-${randomBytes(6).toString("hex")}` })); }
    function editPack(packId, patch) {
        const source = sourceRecipe(packId);
        const packKey = String(packId);
        const installed = teamService.list().teams.some((team) => team.packId === packKey);
        if (!packKey.startsWith("custom") && !recipeFor(packId) && !installed) throw new Error("only custom team pack recipes can be edited");
        return saveRecipe(normalizePack({ ...source, ...patch, id: source.id }));
    }
    function recipeList() { return state.packRecipes.map((entry) => ({ id: entry.recipe.id, name: entry.recipe.name, description: entry.recipe.description, category: "Custom", coworkerNames: entry.recipe.coworkers.map((item) => item.name), channelNames: entry.recipe.channels.map((item) => item.name), playbookNames: entry.recipe.playbooks.map((item) => item.name), installed: teamService.list().teams.some((team) => team.packId === entry.recipe.id || team.packId === `imported:${entry.recipe.id}`), custom: true })); }
    return { listPlaybooks, createPlaybook, updatePlaybook, archivePlaybook: (id) => setPlaybookState(id, "archived"), restorePlaybook: (id) => setPlaybookState(id, "active"), duplicatePlaybook, importPlaybook, exportPlaybook, assignPlaybook, artifactHub, artifactHistory, computerHistory, recipeList, duplicatePack, editPack, getPackRecipe: (id) => sourceRecipe(id), exportPack: (id) => sourceRecipe(id) };
}
