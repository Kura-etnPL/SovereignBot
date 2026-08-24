import { realpathSync, statSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";
import { randomBytes } from "node:crypto";

// Trusted workspace registry: the ONLY source of execution working directories for Desktop
// tasks. Paths enter exclusively through the user's native folder picker, are canonicalized
// by realpath here, and are rejected when they name unsafe roots or non-directories.
// Planners/models can reference a workspace id but can never mint one.

export function makeWorkspaceId() {
    return `ws_${randomBytes(8).toString("hex")}`;
}

export function canonicalizeWorkspacePath(inputPath, deps = {}) {
    const exists = deps.exists ?? ((path) => {
        try {
            statSync(path);
            return true;
        }
        catch {
            return false;
        }
    });
    const realpath = deps.realpath ?? ((path) => realpathSync(path));

    const value = String(inputPath ?? "");
    if (!value || value.includes("\0"))
        throw new Error("workspace path is empty or contains a NUL byte");
    if (!isAbsolute(value))
        throw new Error("workspace path must be absolute");

    let real;
    if (!exists(value))
        throw new Error("workspace path does not exist");
    try {
        real = realpath(value);
    }
    catch {
        throw new Error("workspace path could not be canonicalized");
    }
    if (!statSync(real).isDirectory())
        throw new Error("workspace path must be a directory");

    if (process.platform === "win32") {
        if (/^\\\\[.?]/.test(real))
            throw new Error("device/UNC-prefixed paths are not accepted as workspaces");
        const parsed = parse(real);
        if (!parsed.root || real === parsed.root)
            throw new Error("drive roots are not accepted as workspaces");
        const relative = real.slice(parsed.root.length).split(sep).filter(Boolean);
        if (relative.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)))
            throw new Error("workspace path contains a reserved device name");
    }
    else if (real === "/")
        throw new Error("filesystem root is not accepted as a workspace");
    return real;
}

// Pure store used by the main-process persistence wrapper.
export function createWorkspaceStore({ now = () => new Date().toISOString(), makeId = makeWorkspaceId } = {}) {
    let state = { schema: "sovereignbot.desktop.workspaces.v1", workspaces: [], defaultWorkspaceId: undefined };

    return {
        snapshot() {
            return structuredClone(state);
        },
        add(rawPath, canonicalize = canonicalizeWorkspacePath) {
            const real = canonicalize(rawPath);
            const existing = state.workspaces.find((workspace) => workspace.path.toLowerCase() === real.toLowerCase());
            if (existing)
                return { added: false, workspace: structuredClone(existing), reason: "already-registered" };
            const workspace = { id: makeId(), path: real, label: real.split(sep).pop() || real, addedAt: now() };
            state.workspaces.push(workspace);
            if (!state.defaultWorkspaceId)
                state.defaultWorkspaceId = workspace.id;
            return { added: true, workspace: structuredClone(workspace) };
        },
        remove(id) {
            const before = state.workspaces.length;
            state.workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
            if (state.defaultWorkspaceId === id)
                state.defaultWorkspaceId = state.workspaces[0]?.id;
            return state.workspaces.length !== before;
        },
        setDefault(id) {
            if (!state.workspaces.some((workspace) => workspace.id === id))
                throw new Error("unknown workspace id");
            state.defaultWorkspaceId = id;
            return true;
        },
        byId(id) {
            return structuredClone(state.workspaces.find((workspace) => workspace.id === id));
        },
        defaultPath() {
            return state.workspaces.find((workspace) => workspace.id === state.defaultWorkspaceId)?.path;
        },
    };
}
