import { join } from "node:path";

// Pure, dependency-injected resolver for the bundled internal Node interpreter.
//
// The packaged Desktop runs Core in the Electron main process, but JavaScript *child*
// processes (governed MCP bridge, WebDriver sidecar, npm-shim provider launchers) need a real
// Node binary. With the RunAsNode fuse disabled the Electron executable must never be used as
// one. Resolution order:
//   1. explicit env override (already hash-verified by the host before export);
//   2. pinned bundled node.exe verified against the committed node-runtime.manifest.json;
//   3. dev-only fallback to process.execPath when it is genuinely a system Node binary;
//   4. otherwise fail closed.
export function createInternalNodeResolver({
    env,
    isPackaged,
    resourcesPath,
    desktopRoot,
    execPathBasename,
    processExecPath,
    exists,
    sha256File,
    readManifest,
}) {
    return function resolveInternalNode() {
        const override = String(env.SOVEREIGNBOT_INTERNAL_NODE ?? "").trim();
        if (override) {
            if (!exists(override))
                throw new Error(`SOVEREIGNBOT_INTERNAL_NODE does not exist: ${override}`);
            return { path: override, source: "env-override", sha256: sha256File(override) };
        }

        const manifest = readManifest();
        const platformKey = `${process.platform}-${process.arch}`;
        const entry = manifest?.platforms?.[platformKey];
        if (!entry)
            throw new Error(`no pinned internal Node runtime declared for ${platformKey}`);

        const bundledPath = isPackaged
            ? join(resourcesPath, entry.file)
            : join(desktopRoot, "resources", "node", entry.file);
        if (exists(bundledPath)) {
            const actual = sha256File(bundledPath);
            if (actual !== entry.sha256) {
                throw new Error(
                    `bundled internal Node failed integrity check at ${bundledPath}: expected ${entry.sha256}, got ${actual}`,
                );
            }
            return { path: bundledPath, source: isPackaged ? "bundled-packaged" : "bundled-dev", sha256: actual };
        }

        if (!isPackaged && /^node(?:\.exe)?$/i.test(execPathBasename ?? "")) {
            return { path: processExecPath, source: "system-node-dev", sha256: undefined };
        }

        throw new Error(
            `internal Node runtime is missing at ${bundledPath}. Run "npm run fetch-node" (dev) or reinstall the application (packaged).`,
        );
    };
}
