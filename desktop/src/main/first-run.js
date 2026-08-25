import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectBrowsers, provisionDriver } from "./lib/driver-provision.js";
import { describeProvider } from "./lib/provider-discovery.js";
import { extractZip } from "./lib/safe-zip.js";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";

const DRIVERS_FILE = "drivers.json";

// Aggregated readiness picture for the Home screen: core state, passive provider discovery,
// managed-browser status with any provisioned driver record. Nothing here sends a model
// prompt or starts a browser; failures degrade individual fields instead of throwing.

function isDirectorySafe(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}

function isFileSafe(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}

function listDirsSafe(path) {
    try {
        return readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
}

export function createFirstRunService({ host, services }) {
    // host: started RuntimeHost exposing dataDir and coreModules resolvers.
    const stateDir = join(host.dataDir, "desktop-state");
    const driversRoot = join(stateDir, "drivers");

    function driverRecord() {
        return loadJsonState(join(stateDir, DRIVERS_FILE), null);
    }

    function saveDriverRecord(record) {
        saveJsonState(join(stateDir, DRIVERS_FILE), record);
    }

    function browserStatus() {
        return detectBrowsers({
            env: process.env,
            existsDir: isDirectorySafe,
            existsFile: isFileSafe,
            listDirs: listDirsSafe,
        });
    }

    return {
        async getStatus() {
            const providers = {};
            for (const [label, key, versionArgs] of [
                ["codex", "resolveCodexLaunch", ["--version"]],
                ["claude", "resolveClaudeCodeLaunch", ["--version"]],
            ]) {
                providers[label] = await describeProvider(() => host.coreModules[key]({}), label === "claude" ? "claude-code" : label, versionArgs);
            }
            return {
                core: { ok: true },
                providers,
                roster: typeof host.rosterSummary === "function" ? host.rosterSummary() : undefined,
                browsers: browserStatus(),
                driver: driverRecord(),
                workspaces: services.listWorkspaces(),
                settings: services.getSettings(),
            };
        },

        async provisionManagedBrowserDriver() {
            const browsers = browserStatus();
            if (!browsers.length)
                return { ok: false, reason: "no supported browser detected" };
            const target = browsers[0];
            const record = await provisionDriver({
                browser: target.browser,
                browserVersion: target.version,
                fetcher: (url) => fetch(url),
                writeArchive: (url, archive, meta) => {
                    const versionDir = join(driversRoot, meta.driverVersion);
                    mkdirSync(versionDir, { recursive: true });
                    const files = [];
                    extractZip(archive, {
                        writeFile: (name, content) => {
                            // Flatten: archives contain chromedriver.exe plus license files.
                            const base = name.split(/[\\/]/).pop();
                            if (!base)
                                throw new Error("unexpected archive layout");
                            writeFileSync(join(versionDir, base), content);
                            files.push(base);
                        },
                    });
                    if (!files.includes("chromedriver.exe"))
                        throw new Error("chromedriver.exe missing from archive");
                    if (!isFileSafe(join(versionDir, "chromedriver.exe")))
                        throw new Error("provisioned chromedriver not found on disk");
                    saveDriverRecord({
                        ...meta,
                        url,
                        browser: target.browser,
                        browserVersion: target.version,
                        cacheDirRelative: join("drivers", meta.driverVersion),
                        exe: "chromedriver.exe",
                        files,
                    });
                },
            });
            return { ok: true, browser: target.browser, ...record };
        },

        driverRecord,
    };
}
