import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceStore, canonicalizeWorkspacePath } from "./lib/workspaces.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

const WORKSPACES_FILE = "workspaces.json";
const SETTINGS_FILE = "settings.json";
const ECONOMY_CONFIG_FILE = "economy-providers.json";

const DEFAULT_ECONOMY_CONFIG = Object.freeze({
    providers: [],
    metered: Object.freeze({ enabled: false, budget: 0, perRunCap: 0, totalCap: 0 }),
});

function loadTrustedEconomyConfig(path) {
    if (!existsSync(path)) return DEFAULT_ECONOMY_CONFIG;
    let value;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("[ECONOMY:CONFIG_CORRUPT] Economy provider configuration cannot be parsed; execution is blocked"); }
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("[ECONOMY:CONFIG_CORRUPT] Economy provider configuration is invalid; execution is blocked");
    return value;
}

export const DESKTOP_SETTINGS_SCHEMA = Object.freeze({
    theme: Object.freeze(["system", "dark", "light"]),
    closeBehavior: Object.freeze(["ask", "tray", "quit"]),
    notifications: "boolean",
    notificationPreferences: "notification-preferences",
    demoMode: "boolean",
    defaultModelProfile: Object.freeze(["automatic", "efficient", "deep", "economy"]),
    language: Object.freeze(["system", "zh-CN", "en"]),
    voiceLanguage: Object.freeze(["system", "zh-CN", "en"]),
    speakReplies: "boolean",
    voiceMuted: "boolean",
    updateChannel: Object.freeze(["stable", "preview", "off"]),
});

export const NOTIFICATION_CATEGORIES = Object.freeze([
    "attention", "routine-completed", "trigger-fired", "coworker-finished", "channel-unread",
]);

function defaultNotificationPreferences() {
    return Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, true]));
}

function defaultSettings() {
    return {
        schema: "sovereignbot.desktop.settings.v1",
        theme: "system",
        closeBehavior: "ask",
        notifications: true,
        notificationPreferences: defaultNotificationPreferences(),
        // Explicit Demo Mode is the only non-test place Echo agents may run. Normal
        // production mode always requires a real, enabled provider.
        demoMode: false,
        defaultModelProfile: "automatic",
        language: "system",
        voiceLanguage: "system",
        speakReplies: false,
        voiceMuted: false,
        updateChannel: "stable",
        providers: { codex: { enabled: true }, claude: { enabled: true }, "chatgpt-web": { enabled: true }, antigravity: { enabled: true }, economy: { enabled: true } },
        roles: {},
    };
}

function normalizeSettings(value) {
    const settings = { ...defaultSettings(), ...value };
    if (!["system", "zh-CN", "en"].includes(settings.language)) settings.language = "system";
    if (!["system", "zh-CN", "en"].includes(settings.voiceLanguage)) settings.voiceLanguage = "system";
    settings.speakReplies = settings.speakReplies === true;
    settings.voiceMuted = settings.voiceMuted === true;
    if (!["stable", "preview", "off"].includes(settings.updateChannel)) settings.updateChannel = "stable";
    if (![
        "automatic", "efficient", "deep", "economy",
    ].includes(settings.defaultModelProfile)) settings.defaultModelProfile = "automatic";
    settings.notificationPreferences = Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [
        category, value?.notificationPreferences?.[category] !== false,
    ]));
    settings.providers = {
        codex: { enabled: value?.providers?.codex?.enabled !== false },
        claude: { enabled: value?.providers?.claude?.enabled !== false },
        "chatgpt-web": { enabled: value?.providers?.["chatgpt-web"]?.enabled !== false },
        antigravity: { enabled: value?.providers?.antigravity?.enabled !== false },
        economy: { enabled: value?.providers?.economy?.enabled !== false },
    };
    settings.roles = value?.roles && typeof value.roles === "object" ? { ...value.roles } : {};
    return settings;
}

function validateProvidersPatch(patch) {
    for (const [provider, entry] of Object.entries(patch)) {
        if (!["codex", "claude", "chatgpt-web", "antigravity", "economy"].includes(provider))
            throw new Error(`unknown provider: ${provider}`);
        if (typeof entry !== "object" || entry === null)
            throw new Error(`${provider} must be an object`);
        if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
            throw new Error(`${provider}.enabled must be a boolean`);
    }
}

const ROLE_IDS = ["planner", "worker", "reviewer", "synthesizer"];

function validateRolesPatch(patch) {
    for (const [role, agentId] of Object.entries(patch)) {
        if (!ROLE_IDS.includes(role))
            throw new Error(`unknown role: ${role}`);
        if (agentId !== null && !/^[A-Za-z0-9][\w:-]{0,63}$/.test(String(agentId)))
            throw new Error(`${role} assignment must be an agent identifier or null`);
    }
}

function validateNotificationPreferencesPatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("notificationPreferences must be an object");
    for (const [category, enabled] of Object.entries(patch)) {
        if (!NOTIFICATION_CATEGORIES.includes(category)) throw new Error(`unknown notification category: ${category}`);
        if (typeof enabled !== "boolean") throw new Error(`${category} notification preference must be a boolean`);
    }
}

// Main-process services bound to a started runtime host: trusted workspaces, desktop
// settings, first-run status aggregation, and driver provisioning records.
export function createDesktopServices({ dataDir, dialog }) {
    const stateDir = join(dataDir, "desktop-state");
    const workspacesPath = join(stateDir, WORKSPACES_FILE);
    const settingsPath = join(stateDir, SETTINGS_FILE);
    const economyConfigPath = join(stateDir, ECONOMY_CONFIG_FILE);

    const persistedWorkspaces = loadJsonState(workspacesPath, null);
    const store = createWorkspaceStore();
    const workspaceKinds = new Map();
    if (persistedWorkspaces?.schema === "sovereignbot.desktop.workspaces.v1" && Array.isArray(persistedWorkspaces.workspaces)) {
        for (const workspace of persistedWorkspaces.workspaces) {
            try {
                const result = store.add(workspace.path, canonicalizeWorkspacePath, workspace);
                if (workspace.kind && result.workspace?.id)
                    workspaceKinds.set(result.workspace.id, String(workspace.kind).slice(0, 64));
            }
            catch {
                // A previously valid directory may be gone; skip it rather than fail startup.
            }
        }
        if (persistedWorkspaces.defaultWorkspaceId) {
            try {
                store.setDefault(persistedWorkspaces.defaultWorkspaceId);
            }
            catch {
            }
        }
    }

    let settings = defaultSettings();
    const persistedSettings = loadJsonState(settingsPath, null);
    if (persistedSettings?.schema === defaultSettings().schema) {
        // v1.1.0 settings files predate demoMode/providers/roles; normalizeSettings
        // backfills the new fields so old installs migrate in place, idempotently.
        settings = normalizeSettings(persistedSettings);
    }
    const economyConfig = loadTrustedEconomyConfig(economyConfigPath);

    function workspaceSnapshot() {
        const snapshot = store.snapshot();
        snapshot.workspaces = snapshot.workspaces.map((workspace) => ({
            ...workspace,
            ...(workspaceKinds.has(workspace.id) ? { kind: workspaceKinds.get(workspace.id) } : {}),
        }));
        return snapshot;
    }

    function publicWorkspace(workspace) {
        if (!workspace)
            return undefined;
        return {
            id: workspace.id,
            label: workspace.label,
            ...(workspace.kind ? { kind: workspace.kind } : {}),
            addedAt: workspace.addedAt,
        };
    }

    function saveWorkspaces() {
        saveJsonState(workspacesPath, workspaceSnapshot());
    }

    return {
        stateDir,

        listWorkspaces() {
            const snapshot = workspaceSnapshot();
            return {
                schema: snapshot.schema,
                defaultWorkspaceId: snapshot.defaultWorkspaceId,
                workspaces: snapshot.workspaces.map(publicWorkspace),
            };
        },

        // Main-process-only hydration for product registries.  The path is never
        // returned through IPC; consumers must retain only the trusted opaque id.
        listWorkspacesInternal() {
            return structuredClone(workspaceSnapshot());
        },

        async addWorkspaceViaDialog(parentWindow) {
            const result = await dialog.showOpenDialog(parentWindow, {
                title: "Choose a workspace folder",
                properties: ["openDirectory", "dontAddToRecent"],
                buttonLabel: "Use folder",
            });
            if (result.canceled || !result.filePaths?.length)
                return { added: false };
            // The native picker returns exactly one absolute directory; canonicalization is
            // still enforced here so nothing bypasses the registry rules.
            const outcome = store.add(result.filePaths[0], canonicalizeWorkspacePath);
            saveWorkspaces();
            return { added: outcome.added, workspace: publicWorkspace({ ...outcome.workspace, kind: workspaceKinds.get(outcome.workspace?.id) }), reason: outcome.reason };
        },

        addWorkspacePath(path) {
            const outcome = store.add(path, canonicalizeWorkspacePath);
            saveWorkspaces();
            // This is a main-process/test helper, not an IPC projection.  Keep the
            // canonical path available to trusted acceptance helpers and controllers.
            return { added: outcome.added, workspace: outcome.workspace ? { ...outcome.workspace, kind: workspaceKinds.get(outcome.workspace.id) } : undefined, reason: outcome.reason };
        },

        // Internal Team Pack provisioning.  Only the workspace id/label is returned to
        // product projections; this path is consumed by trusted main-process services.
        createManagedWorkspace({ label, kind = "shared-project", idHint } = {}) {
            const safeHint = String(idHint ?? `workspace-${Date.now().toString(36)}`)
                .replace(/[^A-Za-z0-9._-]/g, "-")
                .slice(0, 80);
            const managedPath = join(stateDir, "managed-workspaces", safeHint);
            mkdirSync(managedPath, { recursive: true });
            const outcome = store.add(managedPath, canonicalizeWorkspacePath, { label });
            if (outcome.workspace?.id)
                workspaceKinds.set(outcome.workspace.id, String(kind).slice(0, 64));
            saveWorkspaces();
            const workspace = { ...outcome.workspace, kind: workspaceKinds.get(outcome.workspace?.id) };
            return { workspace: structuredClone(workspace), path: workspace.path };
        },

        removeWorkspace(id) {
            const removed = store.remove(String(id));
            workspaceKinds.delete(String(id));
            saveWorkspaces();
            return removed;
        },

        setDefaultWorkspace(id) {
            const ok = store.setDefault(String(id));
            saveWorkspaces();
            return ok;
        },

        workspacePath(id) {
            return store.byId(String(id))?.path;
        },

        workspaceLabel(id) {
            return store.byId(String(id))?.label;
        },

        defaultWorkspacePath() {
            return store.defaultPath();
        },

        getSettings() {
            return structuredClone(settings);
        },

        getEconomyConfig() {
            return structuredClone(economyConfig);
        },

        updateSettings(patch) {
            if (patch.providers !== undefined)
                validateProvidersPatch(patch.providers);
            if (patch.roles !== undefined)
                validateRolesPatch(patch.roles);
            if (patch.notificationPreferences !== undefined)
                validateNotificationPreferencesPatch(patch.notificationPreferences);
            for (const [key, allowed] of Object.entries(DESKTOP_SETTINGS_SCHEMA)) {
                if (patch[key] === undefined)
                    continue;
                if (Array.isArray(allowed)) {
                    if (!allowed.includes(patch[key]))
                        throw new Error(`invalid value for ${key}`);
                    settings[key] = patch[key];
                }
                else if (allowed === "boolean") {
                    if (typeof patch[key] !== "boolean")
                        throw new Error(`${key} must be a boolean`);
                    settings[key] = patch[key];
                }
                else if (allowed === "notification-preferences") {
                    validateNotificationPreferencesPatch(patch[key]);
                    for (const category of NOTIFICATION_CATEGORIES) {
                        if (patch[key][category] !== undefined)
                            settings.notificationPreferences[category] = patch[key][category];
                    }
                }
            }
            if (patch.providers !== undefined) {
                for (const provider of ["codex", "claude", "chatgpt-web", "antigravity", "economy"]) {
                    if (patch.providers[provider]?.enabled !== undefined)
                        settings.providers[provider].enabled = patch.providers[provider].enabled;
                }
            }
            if (patch.roles !== undefined) {
                for (const role of ROLE_IDS) {
                    if (patch.roles[role] !== undefined)
                        settings.roles[role] = patch.roles[role];
                }
            }
            saveJsonState(settingsPath, settings);
            return structuredClone(settings);
        },
    };
}
