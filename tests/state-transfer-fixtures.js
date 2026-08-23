import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "../src/audit.js";
import { policyHash } from "../src/policy-version-store.js";
import { STATE_BACKUP_FORMAT } from "../src/state-transfer.js";

export const TASK_SECRET = "TASK_SECRET_DO_NOT_EXPORT_70f2";
export const MEMORY_SECRET = "MEMORY_SECRET_DO_NOT_EXPORT_51ad";
export const AUDIT_SECRET = "AUDIT_SECRET_DO_NOT_EXPORT_4d73";
export const CONFIG_SECRET = "CONFIG_SECRET_DO_NOT_DERIVE_2b90";
export const COMPUTER_TOKEN = "COMPUTER_TOKEN_SENSITIVE_a81d";
export const BROWSER_SECRET = "BROWSER_COOKIE_SENSITIVE_b774";
export const WORKSPACE_SECRET = "WORKSPACE_DATA_SENSITIVE_1a93";
export const OPERATOR_SESSION_SECRET = "OPERATOR_SESSION_EPHEMERAL_2c04";
export const BRIDGE_SECRET = "BRIDGE_CAPABILITY_EPHEMERAL_9f11";
export const VERSION_ID = "policy_12345678-1234-4abc-8def-1234567890ab";
export const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function policy() {
    return {
        repeatWindowMs: 180000,
        repeatMaxActiveFingerprints: 10000,
        rules: [{
            id: "allow-test",
            effect: "allow",
            match: { category: "harness", operation: "run" },
        }],
    };
}

export async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
            return false;
        throw error;
    }
}

export async function allFiles(root, relativeRoot = "") {
    if (!await exists(root))
        return [];
    const out = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        const rel = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            out.push(...await allFiles(path, rel));
        else
            out.push(rel);
    }
    return out.sort();
}

export async function bundleText(root) {
    let text = "";
    for (const rel of await allFiles(root))
        text += await readFile(join(root, ...rel.split("/")), "utf8");
    return text;
}

export function cloneConfig(config, dataDir) {
    return { ...structuredClone(config), dataDir };
}

export async function seedState(root, { withComputers = true } = {}) {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const config = {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        privateConfigValue: CONFIG_SECRET,
        agents: [{
            id: "worker",
            name: "Worker",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        }],
        policy: policy(),
    };

    await writeJson(join(dataDir, "tasks.json"), [{
        id: "task_1",
        kind: "work",
        title: "backup fixture",
        status: "queued",
        input: { privateValue: TASK_SECRET },
    }]);
    await writeFile(join(dataDir, "task-events.jsonl"), `${JSON.stringify({
        id: "event_1",
        seq: 1,
        at: new Date().toISOString(),
        taskId: "task_1",
        type: "task.created",
        data: { privateValue: TASK_SECRET },
    })}\n`, "utf8");
    await writeFile(join(dataDir, "memory.jsonl"), `${JSON.stringify({
        id: "mem_1",
        at: new Date().toISOString(),
        scope: "task:task_1",
        key: "private",
        value: MEMORY_SECRET,
        tags: [],
    })}\n`, "utf8");
    await writeJson(join(dataDir, "repeat-state.json"), {
        version: 1,
        entries: { ["a".repeat(64)]: [Date.now()] },
    });

    const audit = new AuditLog(join(dataDir, "audit.jsonl"));
    await audit.init();
    await audit.append({
        type: "test.seeded",
        actor: "test",
        subject: "task_1",
        data: { note: AUDIT_SECRET },
    });

    const activePolicy = policy();
    const hash = policyHash(activePolicy);
    const createdAt = new Date().toISOString();
    await writeJson(join(dataDir, "policy-versions", "active.json"), {
        schemaVersion: 1,
        versionId: VERSION_ID,
        hash,
        activatedAt: createdAt,
    });
    await writeJson(join(dataDir, "policy-versions", "versions", `${VERSION_ID}.json`), {
        schemaVersion: 1,
        id: VERSION_ID,
        hash,
        createdAt,
        source: "test",
        label: "fixture",
        policy: activePolicy,
    });

    await writeJson(join(dataDir, "operator-sessions", `${"b".repeat(64)}.json`), {
        version: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        label: OPERATOR_SESSION_SECRET,
    });
    await writeJson(join(dataDir, "tool-bridges", "bridge_1.bootstrap.json"), {
        protocol: "sovereignbot.governed-bridge.v1",
        capability: BRIDGE_SECRET,
    });
    await writeJson(join(dataDir, "tool-bridges", "bridge_1.claude-mcp.json"), {
        mcpServers: { sovereignbot: { args: [BRIDGE_SECRET] } },
    });

    if (withComputers) {
        await mkdir(join(dataDir, "computers", "d29ya2Vy", "profile"), { recursive: true });
        await mkdir(join(dataDir, "computers", "d29ya2Vy", "workspace"), { recursive: true });
        await writeFile(join(dataDir, "computers", "operator-token"), `${COMPUTER_TOKEN}\n`, "utf8");
        await writeFile(join(dataDir, "computers", "d29ya2Vy", "token"), `${COMPUTER_TOKEN}-worker\n`, "utf8");
        await writeFile(join(dataDir, "computers", "d29ya2Vy", "profile", "Cookies"), `${BROWSER_SECRET}\n`, "utf8");
        await writeFile(join(dataDir, "computers", "d29ya2Vy", "workspace", "note.txt"), `${WORKSPACE_SECRET}\n`, "utf8");
        await writeJson(join(dataDir, "computers", "state.json"), { version: 2, agents: {} });
    }

    const configPath = join(root, "config.json");
    await writeJson(configPath, config);
    return { config, configPath, dataDir };
}

export async function writeValidBundle(root, files, {
    mode = "core",
    sensitiveComputerState = mode === "full-computer",
} = {}) {
    const manifestFiles = [];
    for (const [path, value] of Object.entries(files)) {
        const content = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
        await mkdir(dirname(join(root, "files", ...path.split("/"))), { recursive: true });
        await writeFile(join(root, "files", ...path.split("/")), content);
        manifestFiles.push({ path, size: content.length, sha256: sha256(content), mode: 0o600 });
    }
    await writeJson(join(root, "manifest.json"), {
        format: STATE_BACKUP_FORMAT,
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        sourceVersion: "0.4.0-dev-test",
        mode,
        sensitiveComputerState,
        offlineConsistencyRequired: true,
        files: manifestFiles,
    });
}

export async function writeManifestOnly(root, path, {
    mode = "core",
    sensitiveComputerState = mode === "full-computer",
} = {}) {
    await mkdir(root, { recursive: true });
    await writeJson(join(root, "manifest.json"), {
        format: STATE_BACKUP_FORMAT,
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        sourceVersion: "0.4.0-dev-test",
        mode,
        sensitiveComputerState,
        offlineConsistencyRequired: true,
        files: [{ path, size: 0, sha256: sha256(Buffer.alloc(0)), mode: 0o600 }],
    });
}
