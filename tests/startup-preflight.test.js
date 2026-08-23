import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { preflightRuntimeStartup } from "../src/startup-preflight.js";

function config(dataDir, overrides = {}) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: overrides.agents ?? [{
            id: "echo",
            name: "Echo",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        }],
        policy: overrides.policy ?? {
            repeatWindowMs: 180000,
            repeatMaxActiveFingerprints: 10000,
            rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
        },
        ...(overrides.computer ? { computer: overrides.computer } : {}),
    };
}

async function files(root, relativeRoot = "") {
    const out = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
        const absolute = join(root, entry.name);
        const rel = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            out.push(...await files(absolute, rel));
        else if (entry.isFile())
            out.push([rel, (await readFile(absolute)).toString("base64")]);
        else
            out.push([rel, `special:${entry.isSymbolicLink()}`]);
    }
    return out.sort(([a], [b]) => a.localeCompare(b));
}

async function writeJson(path, value) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(path) {
    try {
        await readFile(path);
        return true;
    }
    catch (error) {
        if (["ENOENT", "EISDIR"].includes(error.code))
            return error.code === "EISDIR";
        throw error;
    }
}

test("tampered audit blocks startup before any unrelated runtime state mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-startup-audit-"));
    const dataDir = join(root, "data");
    let runtime;
    try {
        runtime = await createRuntime(config(dataDir));
        await runtime.audit.append({ type: "test.seed", actor: "test", subject: "state", data: { ok: true } });
        await runtime.close();
        runtime = undefined;

        const auditPath = join(dataDir, "audit.jsonl");
        const rows = (await readFile(auditPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
        rows[0].actor = "tampered";
        await writeFile(auditPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
        const before = await files(dataDir);

        await assert.rejects(() => createRuntime(config(dataDir)), /startup preflight failed: audit hash chain is invalid/);
        assert.deepEqual(await files(dataDir), before);
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("corrupt core files fail before runtime bootstrap creates unrelated state", async () => {
    const cases = [
        ["tasks.json", "{}\n", /tasks\.json must contain an array/],
        ["memory.jsonl", "{bad json\n", /memory\.jsonl contains invalid JSONL/],
        ["task-events.jsonl", `${JSON.stringify({ id: "event_a", taskId: "task_a", seq: 2, at: new Date().toISOString(), type: "task.started" })}\n`, /event sequence is non-contiguous/],
        ["repeat-state.json", `${JSON.stringify({ version: 1, entries: { bad: [1] } })}\n`, /invalid fingerprint\/timestamp/],
    ];
    for (const [name, content, pattern] of cases) {
        const root = await mkdtemp(join(tmpdir(), "sovereign-startup-core-"));
        const dataDir = join(root, "data");
        try {
            await mkdir(dataDir, { recursive: true });
            await writeFile(join(dataDir, name), content, "utf8");
            const before = await files(dataDir);
            await assert.rejects(() => createRuntime(config(dataDir)), pattern, name);
            assert.deepEqual(await files(dataDir), before, name);
            assert.equal(await exists(join(dataDir, "policy-versions")), false, name);
            assert.equal(await exists(join(dataDir, "computers")), false, name);
            assert.equal(await exists(join(dataDir, "operator-sessions")), false, name);
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("unsupported computer state version and empty token fail before migration/token creation", async () => {
    for (const mode of ["version", "token"]) {
        const root = await mkdtemp(join(tmpdir(), "sovereign-startup-computer-"));
        const dataDir = join(root, "data");
        try {
            const computers = join(dataDir, "computers");
            await mkdir(computers, { recursive: true });
            if (mode === "version")
                await writeJson(join(computers, "state.json"), { version: 99, agents: {} });
            else
                await writeFile(join(computers, "operator-token"), "\n", "utf8");
            const before = await files(dataDir);
            await assert.rejects(
                () => createRuntime(config(dataDir)),
                mode === "version" ? /computer state has an unsupported schema\/version/ : /computer operator token is empty/,
            );
            assert.deepEqual(await files(dataDir), before);
            assert.equal(await exists(join(computers, "state.json")), mode === "version");
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("stale governed bridge state blocks startup and is not deleted automatically", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-startup-bridge-"));
    const dataDir = join(root, "data");
    try {
        const bridge = join(dataDir, "tool-bridges", "stale.bootstrap.json");
        await mkdir(join(dataDir, "tool-bridges"), { recursive: true });
        await writeFile(bridge, "CAPABILITY_MUST_REMAIN_FOR_EXPLICIT_RECOVERY\n", "utf8");
        await assert.rejects(() => createRuntime(config(dataDir)), /stale governed tool-bridge bootstrap state requires explicit recovery/);
        assert.equal(await readFile(bridge, "utf8"), "CAPABILITY_MUST_REMAIN_FOR_EXPLICIT_RECOVERY\n");
        assert.equal(await exists(join(dataDir, "computers")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("dataDir and computer registry symlink/junction roots fail closed where the platform permits creating them", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-startup-symlink-"));
    try {
        const target = join(root, "target");
        await mkdir(target);
        const dataLink = join(root, "data-link");
        try {
            await symlink(target, dataLink, process.platform === "win32" ? "junction" : "dir");
        }
        catch (error) {
            if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
                t.skip(`runner cannot create directory link: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(() => preflightRuntimeStartup(config(dataLink)), /dataDir traverses a symbolic-link\/junction component/);

        const dataDir = join(root, "data");
        await mkdir(dataDir);
        const computerTarget = join(root, "computer-target");
        await mkdir(computerTarget);
        await symlink(computerTarget, join(dataDir, "computers"), process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(() => createRuntime(config(dataDir)), /computers must be a normal non-symlink directory/);
        assert.deepEqual(await readdir(computerTarget), []);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("supported v0.3 computer state still migrates after passing preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-startup-legacy-"));
    const dataDir = join(root, "data");
    let runtime;
    try {
        const legacy = join(dataDir, "computers", "worker");
        await mkdir(join(legacy, "profile"), { recursive: true });
        await mkdir(join(legacy, "workspace"), { recursive: true });
        await writeFile(join(legacy, "token"), "legacy-token\n", "utf8");
        await writeJson(join(dataDir, "computers", "state.json"), {
            worker: {
                control: {
                    mode: "human",
                    actorId: "operator",
                    updatedAt: "2026-08-20T00:00:00.000Z",
                },
            },
        });
        runtime = await createRuntime(config(dataDir, {
            agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } }],
        }));
        const record = await runtime.computerRegistry.ensure("worker");
        assert.equal(basename(record.rootDir), Buffer.from("worker", "utf8").toString("base64url"));
        assert.equal((await runtime.computerRegistry.credentials("worker")).token, "legacy-token");
        assert.equal((await runtime.computerRegistry.control("worker")).mode, "human");
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("missing optional provider executable does not become a startup blocker", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-startup-provider-"));
    let runtime;
    try {
        runtime = await createRuntime(config(join(root, "data"), {
            agents: [{
                id: "codex-optional",
                name: "Optional Codex",
                role: "worker",
                capabilities: ["coding"],
                harness: { kind: "codex", command: `definitely-missing-codex-${process.pid}` },
            }],
        }));
        assert.ok(runtime);
    }
    finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});
