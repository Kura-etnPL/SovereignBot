import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
async function runtimeWithPolicy(allow) {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-runtime-"));
    const config = {
        dataDir: dir,
        agents: [
            {
                id: "worker",
                name: "Worker",
                role: "worker",
                capabilities: ["research"],
                harness: { kind: "echo" },
            },
        ],
        policy: {
            rules: allow
                ? [{ id: "allow-echo", effect: "allow", match: { category: "harness", targetGlob: "echo" } }]
                : [],
        },
    };
    return createRuntime(config);
}
test("orchestrator schedules by capability and persists a result", async () => {
    const runtime = await runtimeWithPolicy(true);
    const task = await runtime.orchestrator.submit({
        title: "research topic",
        input: { q: "local agents" },
        requiredCapabilities: ["research"],
    });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result?.status, "completed");
    assert.equal(result?.assignedAgentId, "worker");
    assert.equal((await runtime.memory.latest(`task:${task.id}`, "result"))?.value !== undefined, true);
    assert.deepEqual(await runtime.audit.verify(), { ok: true, count: 4 });
});
test("orchestrator blocks execution when policy has no allow", async () => {
    const runtime = await runtimeWithPolicy(false);
    await runtime.orchestrator.submit({ title: "blocked", requiredCapabilities: ["research"] });
    const result = await runtime.orchestrator.runNext();
    assert.equal(result?.status, "blocked");
});
