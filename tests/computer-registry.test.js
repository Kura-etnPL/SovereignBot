import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
