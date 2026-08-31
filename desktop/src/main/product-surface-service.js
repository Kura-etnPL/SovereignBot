import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

export const PRODUCT_SURFACES_SCHEMA = "sovereignbot.desktop.product-surfaces.v1";
const PLAYBOOK_SCHEMA = "sovereignbot.desktop.playbook.v1";
const PACK_SCHEMA = "sovereignbot.desktop.team-pack.v1";
const MAX_PLAYBOOKS = 256;
const MAX_PACK_RECIPES = 128;

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

function normalizePlaybook(input, { requireSchema = false, generatedId } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("playbook must be an object");
    const allowed = new Set(["schema", "id", "name", "description", "steps"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`playbook field is not allowed: ${key}`);
    if (requireSchema && input.schema !== PLAYBOOK_SCHEMA) throw new Error(`playbook schema must be ${PLAYBOOK_SCHEMA}`);
    const steps = input.steps;
    if (!Array.isArray(steps) || steps.length > 12) throw new Error("playbook steps must be an array of at most 12 identifiers");
    return {
        id: id(generatedId ?? input.id, "playbookId"),
        name: text(input.name, "playbook name", 120, true),
        description: text(input.description ?? "", "playbook description", 500),
        steps: steps.map((step) => id(step, "playbook step")),
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
    const out = text(value ?? "", "history text", max).replace(/[A-Za-z]:[\\/][^\s]*/g, "[redacted-path]").replace(/(?:token|secret|password|cookie|session|credential)\s*[:=]\s*[^\s]+/gi, "$1=[redacted]");
    return out;
}

export function createProductSurfaceService({ dataDir, teamService, coworkerStore, artifactStore, runtime, now = () => new Date().toISOString() } = {}) {
    if (!dataDir || !teamService || !coworkerStore || !artifactStore || !runtime) throw new Error("product surface service requires existing stores and runtime");
    const persistPath = join(dataDir, "desktop-state", "product-surfaces.json");
    const loaded = loadJsonState(persistPath, null);
    const state = loaded?.schema === PRODUCT_SURFACES_SCHEMA ? {
        playbooks: Array.isArray(loaded.playbooks) ? loaded.playbooks : [],
        packRecipes: Array.isArray(loaded.packRecipes) ? loaded.packRecipes : [],
    } : { playbooks: [], packRecipes: [] };
    state.playbooks = state.playbooks.filter((entry) => { try { normalizePlaybook(entry); return typeof entry.createdAt === "string" && typeof entry.updatedAt === "string"; } catch { return false; } }).slice(-MAX_PLAYBOOKS);
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
        return { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: [...entry.steps], state: entry.state, createdAt: entry.createdAt, updatedAt: entry.updatedAt, assignedTeams: teams, assignedChannels: channels };
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
        const next = normalizePlaybook({ id: entry.id, name: patch.name ?? entry.name, description: patch.description ?? entry.description, steps: patch.steps ?? entry.steps }); Object.assign(entry, next, { updatedAt: now() }); save(); return publicPlaybook(entry);
    }
    function setPlaybookState(playbookId, value) { const entry = playbookById(playbookId); entry.state = value; entry.updatedAt = now(); save(); return publicPlaybook(entry); }
    function duplicatePlaybook(playbookId) { const entry = playbookById(playbookId); return createPlaybook({ name: `${entry.name} copy`, description: entry.description, steps: entry.steps }); }
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
            if (!team.playbooks.some((item) => item.id === entry.id)) teamService.importPlaybook(team.id, { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: entry.steps });
        } else {
            const channel = teamService.getChannel(channelId);
            if (!teamService.get(channel.teamId).playbooks.some((item) => item.id === entry.id)) teamService.importPlaybook(channel.teamId, { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: entry.steps });
            teamService.updateChannel(channel.id, { playbookId: entry.id });
        }
        return publicPlaybook(entry);
    }
    function exportPlaybook(playbookId) { const entry = playbookById(playbookId); return { schema: PLAYBOOK_SCHEMA, id: entry.id, name: entry.name, description: entry.description, steps: [...entry.steps] }; }
    function artifactHub({ limit = 100, teamId, channelId, coworkerId } = {}) {
        const teams = teamService.list().teams; const channels = teams.flatMap((team) => (team.channels ?? []).map((channel) => ({ ...channel, teamId: team.id, teamName: team.name })));
        const allowedConversationIds = new Set(channels.filter((channel) => (!teamId || channel.teamId === teamId) && (!channelId || channel.id === channelId)).map((channel) => channel.conversationId));
        const result = artifactStore.list({ limit, coworkerId }).artifacts.filter((artifact) => !artifact.conversationId || allowedConversationIds.has(artifact.conversationId)).map((artifact) => {
            const channel = channels.find((item) => item.conversationId === artifact.conversationId); const creator = artifact.createdByCoworkerId ? coworkerStore.get(artifact.createdByCoworkerId) : undefined;
            return { id: artifact.id, title: artifact.title, fileName: artifact.fileName, mimeType: artifact.mimeType, size: artifact.size, createdAt: artifact.createdAt, creator: creator ? { id: creator.id, name: creator.name } : undefined, coworkerId: artifact.createdByCoworkerId, team: channel ? { id: channel.teamId, name: channel.teamName } : undefined, channel: channel ? { id: channel.id, name: channel.name } : undefined, conversationId: artifact.conversationId, status: "available" };
        });
        return { artifacts: result };
    }
    async function computerHistory({ limit = 100 } = {}) {
        const rows = await runtime.audit.readAll(); const result = [];
        for (const row of rows.slice(-Math.min(500, Math.max(1, limit * 4))).reverse()) {
            const type = String(row?.type ?? ""); if (!/(computer|takeover)/i.test(type)) continue;
            const data = row?.data && typeof row.data === "object" ? row.data : {}; const forbidden = JSON.stringify(data).match(/token|secret|password|cookie|session|credential|webdriver|profile|lease|path|coord|typed/i); if (forbidden) continue;
            result.push({ id: row.id, activity: safeHistoryText(type), coworkerId: typeof data.coworkerId === "string" ? data.coworkerId : undefined, summary: safeHistoryText(data.summary ?? data.action ?? type), app: data.app ? safeHistoryText(data.app, 80) : undefined, site: data.site ? safeHistoryText(data.site, 180) : undefined, timestamp: row.at, status: data.ok === false || /failed/i.test(type) ? "failed" : "completed" });
            if (result.length >= limit) break;
        }
        return { history: result };
    }
    function recipeFor(packId) { return state.packRecipes.find((entry) => entry.recipe.id === String(packId)); }
    function findInstalledTeam(packId) { return teamService.list().teams.find((team) => team.packId === String(packId)); }
    function sourceRecipe(packId) { const saved = recipeFor(packId); if (saved) return normalizePack(saved.recipe); const team = findInstalledTeam(packId); if (!team) throw new Error(`unknown team pack: ${packId}`); return normalizePack(teamService.exportPack(team.id)); }
    function saveRecipe(recipe) { const current = recipeFor(recipe.id); if (current) current.recipe = recipe; else state.packRecipes.push({ recipe, updatedAt: now() }); save(); return clone(recipe); }
    function duplicatePack(packId) { const source = sourceRecipe(packId); return saveRecipe(normalizePack(source, { generatedId: `custom-pack-${randomBytes(6).toString("hex")}` })); }
    function editPack(packId, patch) { const source = sourceRecipe(packId); if (!String(packId).startsWith("custom") && !recipeFor(packId)) throw new Error("only custom team pack recipes can be edited"); return saveRecipe(normalizePack({ ...source, ...patch, id: source.id })); }
    function recipeList() { return state.packRecipes.map((entry) => ({ id: entry.recipe.id, name: entry.recipe.name, description: entry.recipe.description, coworkerNames: entry.recipe.coworkers.map((item) => item.name), channelNames: entry.recipe.channels.map((item) => item.name), playbookNames: entry.recipe.playbooks.map((item) => item.name), installed: teamService.list().teams.some((team) => team.packId === entry.recipe.id || team.packId === `imported:${entry.recipe.id}`), custom: true })); }
    return { listPlaybooks, createPlaybook, updatePlaybook, archivePlaybook: (id) => setPlaybookState(id, "archived"), restorePlaybook: (id) => setPlaybookState(id, "active"), duplicatePlaybook, importPlaybook, exportPlaybook, assignPlaybook, artifactHub, computerHistory, recipeList, duplicatePack, editPack, getPackRecipe: (id) => sourceRecipe(id) };
}
