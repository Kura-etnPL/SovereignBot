import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { ComputerRegistry } from "../src/computer-registry.js";

test("computer directory keys cannot collide across unusual agent ids", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-registry-"));
    const registry = new ComputerRegistry(dataDir, ["/", "_2F"]);
    await registry.init();
    const slash = await registry.ensure("/");
    const literal = await registry.ensure("_2F");
    assert.notEqual(slash.rootDir, literal.rootDir);
    assert.notEqual((await registry.credentials("/")).token, (await registry.credentials("_2F")).token);
});

test("agent and operator tokens are separate authority classes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-registry-auth-"));
    const registry = new ComputerRegistry(dataDir, ["worker"]);
    await registry.init();
    const agent = await registry.credentials("worker");
    const operator = await registry.operatorCredentials();
    assert.equal(await registry.authenticate("worker", agent.token), true);
    assert.equal(await registry.authenticateOperator(agent.token), false);
    assert.equal(await registry.authenticateOperator(operator.token), true);
});

test("v0.3 migration preserves a non-ambiguous legacy token/profile/control state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-registry-migrate-"));
    const root = join(dataDir, "computers");
    const legacyDir = join(root, "worker");
    await mkdir(join(legacyDir, "profile"), { recursive: true });
    await mkdir(join(legacyDir, "workspace"), { recursive: true });
    await writeFile(join(legacyDir, "token"), "legacy-worker-token\n");
    await writeFile(join(root, "state.json"), JSON.stringify({
        worker: {
            control: {
                mode: "human",
                actorId: "operator",
                updatedAt: "2026-08-20T00:00:00.000Z"
            }
        }
    }));

    const registry = new ComputerRegistry(dataDir, ["worker"]);
    await registry.init();
    const record = await registry.ensure("worker");
    const expectedKey = Buffer.from("worker", "utf8").toString("base64url");
    assert.equal(basename(record.rootDir), expectedKey);
    assert.equal((await registry.credentials("worker")).token, "legacy-worker-token");
    assert.equal((await registry.control("worker")).mode, "human");

    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(state.version, 2);
    assert.equal(state.agents[expectedKey].control.mode, "human");
    assert.equal(Object.hasOwn(state, "worker"), false);
});

test("ambiguous legacy directory collisions fail instead of copying one identity into two", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-registry-collision-migrate-"));
    const root = join(dataDir, "computers");
    await mkdir(join(root, "_2F", "profile"), { recursive: true });
    await writeFile(join(root, "_2F", "token"), "ambiguous-token\n");
    const registry = new ComputerRegistry(dataDir, ["/", "_2F"]);
    await assert.rejects(() => registry.init(), /cannot automatically migrate legacy computer directory/);
});
