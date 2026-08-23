import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { publicProviderResult } from "../src/harness.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PROVIDER_REF = "legacy-provider-continuity-DO-NOT-EXPOSE-43";
const BUSINESS_SESSION = "business-session-id-must-remain-visible-43";

function configFor(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{
            id: "worker",
            name: "Worker",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        }],
        policy: {
            rules: [{ id: "allow-harness", effect: "allow", match: { category: "harness" } }],
        },
    };
}

function assertNoProviderRef(label, text) {
    assert.equal(text.includes(PROVIDER_REF), false, `${label} exposed provider continuity ref`);
}

function runCli(configPath, ...args) {
    const result = spawnSync(process.execPath, [CLI_PATH, ...args, "--config", configPath], {
        encoding: "utf8",
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

test("provider result boundary redacts continuity refs from errors but keeps internal metadata", () => {
    const projected = publicProviderResult({
        ok: false,
        error: `provider failed while resuming ${PROVIDER_REF}`,
        metadata: { sessionId: PROVIDER_REF, eventCount: 3 },
    });
    assert.equal(projected.error.includes(PROVIDER_REF), false);
    assert.match(projected.error, /REDACTED_PROVIDER_SESSION/);
    assert.equal(projected.metadata.sessionId, PROVIDER_REF, "internal diagnostic metadata remains available");
});

test("legacy provider continuity duplicates stay at rest but are redacted from Operator and CLI views", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-security-legacy-continuity-"));
    const dataDir = join(root, "data");
    const config = configFor(dataDir);
    const configPath = join(root, "config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    let runtime;
    let server;
    try {
        runtime = await createRuntime(config);
        const now = new Date().toISOString();
        const planId = "task_legacy_plan_security";
        const providerTaskId = "task_legacy_provider_security";
        const businessTaskId = "task_business_session_security";

        await runtime.orchestrator.tasks.upsert({
            id: planId,
            kind: "plan",
            title: "legacy aggregate plan",
            status: "completed",
            ownerAgentId: "worker",
            dependencyIds: [],
            requiredCapabilities: [],
            attempt: 0,
            result: {
                outcome: "partial_failure",
                tasks: [{
                    id: providerTaskId,
                    status: "failed",
                    result: { text: "legacy child result", sessionId: PROVIDER_REF },
                    error: `legacy child error ${PROVIDER_REF}`,
                }],
            },
            createdAt: now,
            updatedAt: now,
        });
        await runtime.orchestrator.tasks.upsert({
            id: providerTaskId,
            kind: "work",
            parentTaskId: planId,
            title: "legacy resumable provider task",
            status: "failed",
            assignedAgentId: "worker",
            ownerAgentId: "worker",
            dependencyIds: [],
            requiredCapabilities: [],
            attempt: 1,
            harnessState: { kind: "codex", sessionId: PROVIDER_REF },
            result: {
                text: "legacy provider result",
                sessionId: PROVIDER_REF,
                nested: { sessionId: PROVIDER_REF },
            },
            candidateResult: { text: "legacy candidate", sessionId: PROVIDER_REF },
            error: `legacy provider error ${PROVIDER_REF}`,
            createdAt: now,
            updatedAt: now,
        });
        await runtime.orchestrator.tasks.upsert({
            id: businessTaskId,
            kind: "work",
            title: "business result with ordinary session id",
            status: "completed",
            assignedAgentId: "worker",
            ownerAgentId: "worker",
            dependencyIds: [],
            requiredCapabilities: [],
            attempt: 0,
            result: { sessionId: BUSINESS_SESSION, text: "business result" },
            createdAt: now,
            updatedAt: now,
        });

        await runtime.memory.put({
            scope: `task:${providerTaskId}`,
            key: "result",
            value: { text: "legacy memory result", sessionId: PROVIDER_REF },
            tags: ["task-result", "worker"],
        });
        await runtime.memory.put({
            scope: "agent:worker",
            key: `task:${providerTaskId}:result`,
            value: { text: "legacy agent memory result", nested: { sessionId: PROVIDER_REF } },
            tags: ["task-result"],
        });
        await runtime.memory.put({
            scope: `task:${providerTaskId}`,
            key: "candidate_result:attempt:1",
            value: { text: "legacy candidate memory", sessionId: PROVIDER_REF },
            tags: ["candidate-result", "worker"],
        });
        await runtime.taskEvents.append({
            taskId: providerTaskId,
            type: "task.failed",
            actor: "worker",
            data: { error: `legacy event error ${PROVIDER_REF}` },
        });
        await runtime.audit.append({
            type: "task.failed",
            actor: "worker",
            subject: providerTaskId,
            data: { error: `legacy audit error ${PROVIDER_REF}` },
        });

        // This review deliberately does not mutate historical durable state or the hash chain.
        assert.equal(JSON.stringify(await runtime.orchestrator.listTasks()).includes(PROVIDER_REF), true);
        assert.equal(JSON.stringify(await runtime.memory.search({ limit: 100 })).includes(PROVIDER_REF), true);
        assert.equal(JSON.stringify(await runtime.taskEvents.list(providerTaskId)).includes(PROVIDER_REF), true);
        assert.equal(JSON.stringify(await runtime.audit.readAll()).includes(PROVIDER_REF), true);

        const operatorSession = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
        server = await startServer(runtime);
        const headers = { authorization: `Bearer ${operatorSession.token}` };

        const overviewText = await (await fetch(`${server.url}/operator/overview`, { headers })).text();
        const graphText = await (await fetch(`${server.url}/operator/tasks/${planId}/graph`, { headers })).text();
        const memoryText = await (await fetch(`${server.url}/operator/memory`, { headers })).text();
        const auditText = await (await fetch(`${server.url}/operator/audit`, { headers })).text();
        const eventsText = await (await fetch(`${server.url}/operator/tasks/${providerTaskId}/events`, { headers })).text();

        for (const [label, text] of [
            ["overview", overviewText],
            ["graph", graphText],
            ["memory", memoryText],
            ["audit", auditText],
            ["events", eventsText],
        ])
            assertNoProviderRef(label, text);

        const overview = JSON.parse(overviewText);
        const providerView = overview.tasks.find((task) => task.id === providerTaskId);
        const businessView = overview.tasks.find((task) => task.id === businessTaskId);
        assert.equal(providerView.hasResumableSession, true);
        assert.equal(Object.hasOwn(providerView, "harnessState"), false);
        assert.equal(Object.hasOwn(providerView.result, "sessionId"), false);
        assert.equal(Object.hasOwn(providerView.result.nested, "sessionId"), false);
        assert.equal(Object.hasOwn(providerView.candidateResult, "sessionId"), false);
        assert.match(providerView.error, /REDACTED_PROVIDER_SESSION/);
        assert.equal(businessView.result.sessionId, BUSINESS_SESSION, "unrelated business sessionId must not be blanket-redacted");

        const graph = JSON.parse(graphText);
        const planView = graph.nodes.find((task) => task.id === planId);
        assert.equal(Object.hasOwn(planView.result.tasks[0].result, "sessionId"), false);
        assert.match(planView.result.tasks[0].error, /REDACTED_PROVIDER_SESSION/);

        await server.close();
        server = undefined;
        await runtime.close();
        runtime = undefined;

        const statusText = runCli(configPath, "status");
        const cliGraphText = runCli(configPath, "graph", planId);
        const cliEventsText = runCli(configPath, "events", providerTaskId);
        assertNoProviderRef("CLI status", statusText);
        assertNoProviderRef("CLI graph", cliGraphText);
        assertNoProviderRef("CLI events", cliEventsText);
        assert.equal(statusText.includes(BUSINESS_SESSION), true, "CLI preserves unrelated business sessionId");
    }
    finally {
        await server?.close();
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
});
