import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const PROFILE_ID = "docker-local-isolated";
const IMAGE = "ubuntu:24.04";
const MAX_OUTPUT = 64_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function safeId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(value ?? ""));
}

function errorWithCode(code, message) {
    const error = new Error(`[LOCAL_ISOLATED:${code}] ${message}`);
    error.code = code;
    return error;
}

function cleanOutput(value) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_OUTPUT);
}

function commandResult(binary, args, { timeoutMs = DEFAULT_TIMEOUT_MS, active, containerName, jobId } = {}) {
    return new Promise((resolveResult, reject) => {
        const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        active?.set(containerName, { child, containerName, jobId, cancel: () => child.kill("SIGKILL") });
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.once("error", (error) => {
            clearTimeout(timer);
            active?.delete(containerName);
            reject(errorWithCode("RUNTIME_UNAVAILABLE", error.message));
        });
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            active?.delete(containerName);
            if (timedOut) return reject(errorWithCode("TIMEOUT", "isolated Computer action timed out"));
            if (code !== 0) return reject(errorWithCode("ACTION_FAILED", cleanOutput(stderr) || `isolated Computer action exited with ${signal ?? code}`));
            resolveResult(cleanOutput(stdout));
        });
    });
}

export function createLocalIsolatedComputer({ services, audit, dockerBinary = process.platform === "win32" ? "docker.exe" : "docker", image = IMAGE, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => new Date().toISOString() } = {}) {
    if (typeof services?.workspacePath !== "function") throw new Error("Local isolated Computer requires trusted workspace services");
    const active = new Map();
    const leases = new Map();

    function workspaceRoot(workspaceId) {
        if (!safeId(workspaceId)) throw errorWithCode("WORKSPACE_INVALID", "workspace is invalid");
        const configured = services.workspacePath(workspaceId);
        if (typeof configured !== "string" || !isAbsolute(configured)) throw errorWithCode("WORKSPACE_UNAVAILABLE", "trusted workspace is unavailable");
        let root;
        try { root = realpathSync(configured); } catch { throw errorWithCode("WORKSPACE_UNAVAILABLE", "trusted workspace is unavailable"); }
        if (!statSync(root).isDirectory()) throw errorWithCode("WORKSPACE_UNAVAILABLE", "trusted workspace is not a directory");
        return root;
    }

    function workspacePath(root, value, { allowDirectory = false } = {}) {
        const clean = String(value ?? "").replaceAll("\\", "/");
        if (!clean || clean === "." && !allowDirectory || isAbsolute(clean) || clean.split("/").includes("..") || clean.includes("\0"))
            throw errorWithCode("PATH_INVALID", "file action must use a workspace-relative path");
        const candidate = resolve(root, clean);
        const rel = relative(root, candidate);
        if (rel.startsWith("..") || isAbsolute(rel)) throw errorWithCode("PATH_INVALID", "file action escaped the trusted workspace");
        const existing = (() => { try { return realpathSync(candidate); } catch { return undefined; } })();
        if (existing) {
            const existingRel = relative(root, existing);
            if (existingRel.startsWith("..") || isAbsolute(existingRel)) throw errorWithCode("PATH_INVALID", "symlinked file escaped the trusted workspace");
        } else {
            let parent = dirname(candidate);
            try { parent = realpathSync(parent); } catch { throw errorWithCode("PATH_INVALID", "file parent is not inside the trusted workspace"); }
            const parentRel = relative(root, parent);
            if (parentRel.startsWith("..") || isAbsolute(parentRel)) throw errorWithCode("PATH_INVALID", "file parent escaped the trusted workspace");
        }
        return `/workspace/${clean}`;
    }

    function containerName(jobId, operation) {
        return `sovereignbot-local-${createHash("sha256").update(`${jobId}:${operation}:${now()}`).digest("hex").slice(0, 20)}`;
    }

    function dockerArgs(root, name, command) {
        return [
            "run", "--rm", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "1",
            "--mount", `type=bind,src=${root},dst=/workspace`, "--workdir", "/workspace", image, ...command,
        ];
    }

    async function removeContainer(name) {
        try { await commandResult(dockerBinary, ["rm", "-f", name], { timeoutMs: 5_000 }); } catch {}
    }

    async function health() {
        try {
            await commandResult(dockerBinary, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5_000 });
            await commandResult(dockerBinary, ["image", "inspect", image, "--format", "{{.Id}}"], { timeoutMs: 5_000 });
            return { state: "online", isolation: "docker", runtime: "docker", profileId: PROFILE_ID, capabilities: ["snapshot", "list_files", "read_file", "write_file", "takeover", "release"] };
        } catch (error) {
            return { state: "offline", isolation: "docker", runtime: "docker", profileId: PROFILE_ID, capabilities: [], reason: cleanOutput(error?.message ?? "Docker runtime unavailable").slice(0, 240) };
        }
    }

    async function execute({ operation, input = {}, jobId, workspaceId } = {}) {
        if (!safeId(jobId)) throw errorWithCode("TASK_INVALID", "Computer action is not bound to a valid running Job");
        const root = workspaceRoot(workspaceId);
        const name = containerName(jobId, operation);
        let command;
        if (operation === "snapshot") {
            command = ["/bin/sh", "-c", "printf '%s\\n' '{\"isolated\":true,\"runtime\":\"docker\",\"workspace\":\"mounted\"}'"];
        } else if (operation === "list_files") {
            command = ["/bin/ls", "-1A", "--", workspacePath(root, input.path ?? ".", { allowDirectory: true })];
        } else if (operation === "read_file") {
            command = ["/bin/cat", "--", workspacePath(root, input.path)];
        } else if (operation === "write_file") {
            command = ["/bin/sh", "-c", "umask 077; printf '%s' \"$1\" > \"$2\"", "sovereignbot-write", String(input.content ?? ""), workspacePath(root, input.path)];
        } else if (operation === "request_help") {
            throw errorWithCode("ATTENTION", String(input.reason ?? "operator help requested").slice(0, 240));
        } else {
            throw errorWithCode("UNSUPPORTED", `Local isolated Computer does not support ${operation}`);
        }
        try {
            const output = await commandResult(dockerBinary, dockerArgs(root, name, command), { timeoutMs, active, containerName: name, jobId });
            const result = operation === "snapshot"
                ? { isolated: true, runtime: "docker", state: "ready" }
                : operation === "list_files"
                    ? { entries: output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).slice(0, 32) }
                    : operation === "read_file"
                        ? { content: output }
                        : { written: true };
            await audit?.append?.({ type: "computer.local_isolated_action_succeeded", actor: jobId, subject: PROFILE_ID, data: { operation, workspaceId } });
            return result;
        } catch (error) {
            await removeContainer(name);
            await audit?.append?.({ type: "computer.local_isolated_action_failed", actor: jobId, subject: PROFILE_ID, data: { operation, workspaceId, reason: cleanOutput(error?.message ?? error).slice(0, 240) } });
            throw error;
        }
    }

    async function lease({ jobId, operation, actorId } = {}) {
        if (!safeId(jobId) || typeof actorId !== "string" || !actorId.trim()) throw errorWithCode("LEASE_INVALID", "Computer lease identity is invalid");
        if (!['takeover', 'release'].includes(operation)) throw errorWithCode("LEASE_INVALID", "Computer lease operation is invalid");
        if (operation === "takeover") leases.set(jobId, actorId.trim().slice(0, 120));
        else leases.delete(jobId);
        return { operation, state: operation === "takeover" ? "takeover" : "agent" };
    }

    return {
        profileId: PROFILE_ID,
        async resolve({ workspaceId } = {}) { workspaceRoot(workspaceId); return { computer: await health(), execute, lease }; },
        health,
        execute,
        lease,
        cancel(jobId) {
            let cancelled = false;
            for (const entry of active.values()) if (entry.jobId === jobId && entry.containerName.startsWith("sovereignbot-local-") && entry.child) { entry.cancel(); cancelled = true; }
            return cancelled;
        },
        async close() { for (const entry of active.values()) entry.cancel?.(); await Promise.all([...active.values()].map((entry) => removeContainer(entry.containerName))); active.clear(); leases.clear(); },
    };
}

export { PROFILE_ID as LOCAL_ISOLATED_PROFILE_ID };
