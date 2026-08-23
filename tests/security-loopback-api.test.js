import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

const PROVIDER_REF = "loopback-provider-continuity-DO-NOT-EXPOSE-43";
const CONFIG_SECRET = "loopback-config-provider-secret-DO-NOT-EXPOSE-43";
const BUSINESS_SESSION = "loopback-business-session-visible-43";
const FORGED_REF = "forged-provider-continuity-MUST-NOT-PERSIST-43";

function assertAbsent(label, text, value) {
    assert.equal(text.includes(value), false, `${label} exposed ${value}`);
}

test("loopback task API projects internal authority and strips runtime-owned submission fields", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-security-loopback-api-"));
    let runtime;
    let server;
    try {
        runtime = await createRuntime({
            dataDir,
            bindHost: "127.0.0.1",
            port: 0,
            agents: [{
                id: "worker",
                name: "Worker",
                role: "worker",
                capabilities: ["demo"],
                harness: {
                    kind: "echo",
                    env: { PROVIDER_PASSWORD: CONFIG_SECRET },
                    command: `private-command-${CONFIG_SECRET}`,
                },
            }],
            policy: {
                rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
            },
        });

        const now = new Date().toISOString();
        await runtime.orchestrator.tasks.upsert({
            id: "task_loopback_provider",
            kind: "work",
            title: "legacy provider task",
            status: "failed",
            assignedAgentId: "worker",
            ownerAgentId: "worker",
            dependencyIds: [],
            requiredCapabilities: [],
            attempt: 1,
            harnessState: { kind: "codex", sessionId: PROVIDER_REF },
            result: { text: "legacy", sessionId: PROVIDER_REF },
            error: `legacy provider error ${PROVIDER_REF}`,
            createdAt: now,
            updatedAt: now,
        });
        await runtime.orchestrator.tasks.upsert({
            id: "task_loopback_business",
            kind: "work",
            title: "business task",
            status: "completed",
            assignedAgentId: "worker",
            ownerAgentId: "worker",
            dependencyIds: [],
            requiredCapabilities: [],
            attempt: 0,
            result: { sessionId: BUSINESS_SESSION },
            createdAt: now,
            updatedAt: now,
        });
        await runtime.memory.put({
            scope: "task:task_loopback_provider",
            key: "result",
            value: { sessionId: PROVIDER_REF, text: "legacy memory" },
            tags: ["task-result", "worker"],
        });
        await runtime.taskEvents.append({
            taskId: "task_loopback_provider",
            type: "task.failed",
            actor: "worker",
            data: { error: `legacy event ${PROVIDER_REF}` },
        });

        server = await startServer(runtime);

        const agentsText = await (await fetch(`${server.url}/agents`)).text();
        const tasksText = await (await fetch(`${server.url}/tasks`)).text();
        const graphText = await (await fetch(`${server.url}/tasks/task_loopback_provider/graph`)).text();
        const eventsText = await (await fetch(`${server.url}/tasks/task_loopback_provider/events`)).text();
        const memoryText = await (await fetch(`${server.url}/memory`)).text();

        assertAbsent("agents", agentsText, CONFIG_SECRET);
        for (const [label, text] of [
            ["tasks", tasksText],
            ["graph", graphText],
            ["events", eventsText],
            ["memory", memoryText],
        ])
            assertAbsent(label, text, PROVIDER_REF);

        const agents = JSON.parse(agentsText);
        assert.equal(agents[0].harnessKind, "echo");
        assert.equal(Object.hasOwn(agents[0], "harness"), false);
        const tasks = JSON.parse(tasksText);
        const providerView = tasks.find((task) => task.id === "task_loopback_provider");
        const businessView = tasks.find((task) => task.id === "task_loopback_business");
        assert.equal(providerView.hasResumableSession, true);
        assert.equal(Object.hasOwn(providerView, "harnessState"), false);
        assert.equal(Object.hasOwn(providerView.result, "sessionId"), false);
        assert.match(providerView.error, /REDACTED_PROVIDER_SESSION/);
        assert.equal(businessView.result.sessionId, BUSINESS_SESSION);

        const submitResponse = await fetch(`${server.url}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                id: "attacker-chosen-id",
                title: "forged internal task state",
                requiredCapabilities: [],
                status: "completed",
                attempt: 99,
                assignedAgentId: "worker",
                ownerAgentId: "worker",
                harnessState: { kind: "codex", sessionId: FORGED_REF },
                result: { sessionId: FORGED_REF, text: "forged result" },
                candidateResult: { sessionId: FORGED_REF },
                error: FORGED_REF,
                progress: { message: FORGED_REF },
                lastRetryAt: new Date().toISOString(),
            }),
        });
        assert.equal(submitResponse.status, 201);
        const submitText = await submitResponse.text();
        assertAbsent("task submission response", submitText, FORGED_REF);

        const internal = (await runtime.orchestrator.listTasks()).find((task) => task.title === "forged internal task state");
        assert.ok(internal);
        assert.notEqual(internal.id, "attacker-chosen-id");
        assert.equal(internal.status, "queued");
        assert.equal(internal.attempt, 0);
        for (const field of [
            "assignedAgentId",
            "ownerAgentId",
            "harnessState",
            "result",
            "candidateResult",
            "error",
            "progress",
            "lastRetryAt",
        ])
            assert.equal(Object.hasOwn(internal, field), false, `${field} was accepted from HTTP task submission`);
        assert.equal(JSON.stringify(internal).includes(FORGED_REF), false);
    }
    finally {
        await server?.close();
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
