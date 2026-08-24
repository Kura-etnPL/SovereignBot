import { join } from "node:path";
import { createWorkspaceStore, canonicalizeWorkspacePath } from "./lib/workspaces.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

const WORKSPACES_FILE = "workspaces.json";
const SETTINGS_FILE = "settings.json";

export const DESKTOP_SETTINGS_SCHEMA = Object.freeze({
    theme: Object.freeze(["system", "dark", "light"]),
    closeBehavior: Object.freeze(["ask", "tray", "quit"]),
    notifications: "boolean",
});

function defaultSettings() {
    return { schema: "sovereignbot.desktop.settings.v1", theme: "system", closeBehavior: "ask", notifications: true };
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
        settings = { ...settings, ...persistedSettings };
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
            saveJsonState(settingsPath, settings);
            return structuredClone(settings);
        },
    };
}
