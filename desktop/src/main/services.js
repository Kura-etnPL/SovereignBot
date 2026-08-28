import { join } from "node:path";
import { createWorkspaceStore, canonicalizeWorkspacePath } from "./lib/workspaces.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

const WORKSPACES_FILE = "workspaces.json";
const SETTINGS_FILE = "settings.json";

export const DESKTOP_SETTINGS_SCHEMA = Object.freeze({
    theme: Object.freeze(["system", "dark", "light"]),
    closeBehavior: Object.freeze(["ask", "tray", "quit"]),
    notifications: "boolean",
    demoMode: "boolean",
    language: Object.freeze(["system", "zh-CN", "en"]),
});

function defaultSettings() {
    return {
        schema: "sovereignbot.desktop.settings.v1",
        theme: "system",
        closeBehavior: "ask",
        notifications: true,
        // Explicit Demo Mode is the only non-test place Echo agents may run. Normal
        // production mode always requires a real, enabled provider.
        demoMode: false,
        language: "system",
        providers: { codex: { enabled: true }, claude: { enabled: true } },
        roles: {},
    };
}

function normalizeSettings(value) {
    const settings = { ...defaultSettings(), ...value };
    if (!["system", "zh-CN", "en"].includes(settings.language)) settings.language = "system";
    settings.providers = {
        codex: { enabled: value?.providers?.codex?.enabled !== false },
        claude: { enabled: value?.providers?.claude?.enabled !== false },
    };
    settings.roles = value?.roles && typeof value.roles === "object" ? { ...value.roles } : {};
    return settings;
}

function validateProvidersPatch(patch) {
    for (const [provider, entry] of Object.entries(patch)) {
        if (!["codex", "claude"].includes(provider))
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

// Main-process services bound to a started runtime host: trusted workspaces, desktop
// settings, first-run status aggregation, and driver provisioning records.
export function createDesktopServices({ dataDir, dialog }) {
    const stateDir = join(dataDir, "desktop-state");
    const workspacesPath = join(stateDir, WORKSPACES_FILE);
    const settingsPath = join(stateDir, SETTINGS_FILE);

    const persistedWorkspaces = loadJsonState(workspacesPath, null);
    const store = createWorkspaceStore();
    if (persistedWorkspaces?.schema === "sovereignbot.desktop.workspaces.v1" && Array.isArray(persistedWorkspaces.workspaces)) {
        for (const workspace of persistedWorkspaces.workspaces) {
            try {
                store.add(workspace.path);
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

    return {
        stateDir,

        listWorkspaces() {
            return store.snapshot();
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
            saveJsonState(workspacesPath, store.snapshot());
            return { added: outcome.added, workspace: outcome.workspace ?? undefined, reason: outcome.reason };
        },

        addWorkspacePath(path) {
            const outcome = store.add(path, canonicalizeWorkspacePath);
            saveJsonState(workspacesPath, store.snapshot());
            return { added: outcome.added, workspace: outcome.workspace ?? undefined, reason: outcome.reason };
        },

        removeWorkspace(id) {
            const removed = store.remove(String(id));
            saveJsonState(workspacesPath, store.snapshot());
            return removed;
        },

        setDefaultWorkspace(id) {
            const ok = store.setDefault(String(id));
            saveJsonState(workspacesPath, store.snapshot());
            return ok;
        },

        workspacePath(id) {
            return store.byId(String(id))?.path;
        },

        defaultWorkspacePath() {
            return store.defaultPath();
        },

        getSettings() {
            return structuredClone(settings);
        },

        updateSettings(patch) {
            if (patch.providers !== undefined)
                validateProvidersPatch(patch.providers);
            if (patch.roles !== undefined)
                validateRolesPatch(patch.roles);
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
            }
            if (patch.providers !== undefined) {
                for (const provider of ["codex", "claude"]) {
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
