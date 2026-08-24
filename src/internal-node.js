import { existsSync, statSync } from "node:fs";

// Resolves the Node interpreter used to launch internal JavaScript child processes
// (governed MCP bridge, WebDriver sidecar, npm-shim provider launchers).
//
// Under the plain CLI, process.execPath is node.exe and behavior is unchanged. Inside the
// packaged Desktop (Electron with RunAsNode fuse disabled), process.execPath is the Electron
// binary and can no longer execute scripts, so the host injects an explicit interpreter path
// through SOVEREIGNBOT_INTERNAL_NODE. The Desktop validates that binary against a pinned,
// reviewed SHA-256 before setting it; this module only refuses missing/empty overrides.
export function internalNodeExecutable(env = process.env) {
    const override = env.SOVEREIGNBOT_INTERNAL_NODE;
    if (override !== undefined) {
        const value = String(override).trim();
        if (!value)
            throw new Error("SOVEREIGNBOT_INTERNAL_NODE is set but empty");
        if (value.includes("\0"))
            throw new Error("SOVEREIGNBOT_INTERNAL_NODE contains a NUL byte");
        if (!existsSync(value) || !statSync(value).isFile())
            throw new Error(`SOVEREIGNBOT_INTERNAL_NODE does not point at a file: ${value}`);
        return value;
    }
    return process.execPath;
}
