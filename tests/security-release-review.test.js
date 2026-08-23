import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMemoryComputerDriverFactory } from "../src/computer-driver.js";
import { GOVERNED_MCP_TOOLS } from "../src/governed-tool-bridge.js";
import { createRuntime } from "../src/runtime.js";
import { startServer } from "../src/server.js";
import { isUnsafeAddress, resolveEgressTarget } from "../sidecars/webdriver/egress-proxy.js";

const CODEX_FIXTURE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const OPERATOR_PROVIDER_CANARY = "provider-resume-canary-DO-NOT-EXPOSE-42";
const PROVIDER_CONFIG_CANARY = "provider-config-secret-DO-NOT-EXPOSE-42";

function harnessPolicy() {
    return {
        repeatWindowMs: 180_000,
        repeatMaxActiveFingerprints: 10_000,
        rules: [{ id: "allow-harness", effect: "allow", match: { category: "harness" } }],
    };
}

async function waitRunning(runtime, taskId) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const task = (await runtime.orchestrator.listTasks()).find((candidate) => candidate.id === taskId);
        if (task?.status === "running")
            return task;
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`task ${taskId} did not enter running state`);
}

for (const provider of [
    { kind: "codex", fixture: CODEX_FIXTURE, sessionId: "fake-codex-session-001" },
    { kind: "claude-code", fixture: CLAUDE_FIXTURE, sessionId: "fake-claude-session-001" },
]) {
    test(`${provider.kind} continuity reference remains internal while public result/memory omit structured sessionId`, async () => {
        const dataDir = await mkdtemp(join(tmpdir(), `sovereign-security-${provider.kind}-`));
        let runtime;
        try {
            runtime = await createRuntime({
                dataDir,
                bindHost: "127.0.0.1",
                port: 0,
                agents: [{
                    id: "provider-worker",
                    name: "Provider worker",
                    role: "worker",
                    capabilities: ["coding"],
                    harness: {
                        kind: provider.kind,
                        command: process.execPath,
                        prefixArgs: [provider.fixture],
                        timeoutMs: 5_000,
                    },
                }],
                policy: harnessPolicy(),
            });
            const task = await runtime.orchestrator.submit({
                title: "security release provider result",
                requiredCapabilities: ["coding"],
            });
            const completed = await runtime.orchestrator.runNext();
            assert.equal(completed.status, "completed");
            assert.equal(completed.harnessState.sessionId, provider.sessionId);
            assert.equal(Object.hasOwn(completed.result, "sessionId"), false);

            const memory = await runtime.memory.search({ scope: `task:${task.id}`, limit: 20 });
            assert.ok(memory.length > 0);
            for (const record of memory) {
                if (record.value && typeof record.value === "object")
                    assert.equal(Object.hasOwn(record.value, "sessionId"), false);
            }

            const completedAudit = (await runtime.audit.readAll()).find((record) => record.type === "task.completed" && record.subject === task.id);
            assert.ok(completedAudit);
            assert.equal(completedAudit.data.harnessMetadata.sessionId, "[REDACTED]");
        }
        finally {
            await runtime?.close();
            await rm(dataDir, { recursive: true, force: true });
        }
    });
}

test("operator task surfaces preserve useful task data but redact provider continuity and authority tokens", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-security-operator-view-"));
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
                harness: { kind: "echo", env: { PROVIDER_SECRET: PROVIDER_CONFIG_CANARY } },
            }],
            policy: harnessPolicy(),
        });
        const now = new Date().toISOString();
        await runtime.orchestrator.tasks.upsert({
            id: "task_security_operator_view",
            kind: "work",
            title: "visible task title",
            input: { note: "visible user data" },
            status: "failed",
            assignedAgentId: "worker",
            ownerAgentId: "worker",
            requiredCapabilities: [],
            dependencyIds: [],
            attempt: 1,
            harnessState: { kind: "codex", sessionId: OPERATOR_PROVIDER_CANARY },
            result: { text: "safe public result" },
            createdAt: now,
            updatedAt: now,
        });

        const workerToken = (await runtime.computer.agentCredentials("worker")).token;
        const durableOperatorToken = (await runtime.computer.operatorCredentials()).token;
        await runtime.audit.append({
            type: "security.release.canary",
            actor: "security-review",
            subject: "task_security_operator_view",
            data: {
                token: workerToken,
                sessionId: OPERATOR_PROVIDER_CANARY,
                cookie: "cookie-canary-DO-NOT-EXPOSE-42",
            },
        });
        const operatorSession = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
        server = await startServer(runtime);
        const headers = { authorization: `Bearer ${operatorSession.token}` };

        const overviewResponse = await fetch(`${server.url}/operator/overview`, { headers });
        assert.equal(overviewResponse.status, 200);
        const overviewText = await overviewResponse.text();
        const overview = JSON.parse(overviewText);
        const visibleTask = overview.tasks.find((task) => task.id === "task_security_operator_view");
        assert.equal(visibleTask.title, "visible task title");
        assert.equal(visibleTask.input.note, "visible user data");
        assert.equal(visibleTask.hasResumableSession, true);
        assert.equal(Object.hasOwn(visibleTask, "harnessState"), false);

        const graphResponse = await fetch(`${server.url}/operator/tasks/task_security_operator_view/graph`, { headers });
        assert.equal(graphResponse.status, 200);
        const graphText = await graphResponse.text();
        const graph = JSON.parse(graphText);
        assert.equal(graph.nodes[0].hasResumableSession, true);
        assert.equal(Object.hasOwn(graph.nodes[0], "harnessState"), false);

        const workersText = await (await fetch(`${server.url}/operator/workers`, { headers })).text();
        const auditText = await (await fetch(`${server.url}/operator/audit`, { headers })).text();
        for (const rawSecret of [
            OPERATOR_PROVIDER_CANARY,
            PROVIDER_CONFIG_CANARY,
            workerToken,
            durableOperatorToken,
            operatorSession.token,
            "cookie-canary-DO-NOT-EXPOSE-42",
        ]) {
            assert.equal(overviewText.includes(rawSecret), false, `overview exposed ${rawSecret}`);
            assert.equal(graphText.includes(rawSecret), false, `graph exposed ${rawSecret}`);
            assert.equal(workersText.includes(rawSecret), false, `worker telemetry exposed ${rawSecret}`);
            assert.equal(auditText.includes(rawSecret), false, `audit API exposed ${rawSecret}`);
        }
        assert.match(auditText, /\[REDACTED\]/);
    }
    finally {
        await server?.close();
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("secret supply is operator-only and governed MCP never exposes a supply-secret tool", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-security-secret-authority-"));
    const drivers = createMemoryComputerDriverFactory();
    let runtime;
    let server;
    let runningPromise;
    try {
        runtime = await createRuntime({
            dataDir,
            bindHost: "127.0.0.1",
            port: 0,
            agents: [{
                id: "worker",
                name: "Worker",
                role: "worker",
                capabilities: ["browser"],
                harness: { kind: "echo", delayMs: 1_500 },
            }],
            policy: {
                rules: [
                    { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                    { id: "allow-computer", effect: "allow", match: { category: "computer", agentId: "worker" } },
                ],
            },
        }, { computerDriverFactory: drivers });

        const record = await runtime.computerRegistry.ensure("worker");
        const driver = await drivers.forComputer(record);
        driver.setPage("https://example.test/login", [{ ref: "password", role: "textbox", name: "Password", type: "password" }]);
        const task = await runtime.orchestrator.submit({ title: "secret authority test", requiredCapabilities: ["browser"] });
        runningPromise = runtime.orchestrator.runNext();
        await waitRunning(runtime, task.id);
        const snapshot = await runtime.computer.snapshot("worker", task.id);
        const request = await runtime.computer.requestSecret("worker", task.id, {
            snapshotId: snapshot.snapshotId,
            ref: snapshot.elements[0].ref,
            label: "Release review secret",
        });

        assert.equal(GOVERNED_MCP_TOOLS.includes("request_secret"), true);
        assert.equal(GOVERNED_MCP_TOOLS.some((tool) => /supply.*secret|secret.*supply/i.test(tool)), false);

        const agentToken = (await runtime.computer.agentCredentials("worker")).token;
        const operatorSession = await runtime.operatorSessions.issue({ ttlMs: 60_000 });
        server = await startServer(runtime);
        const secret = "release-review-secret-plaintext-DO-NOT-PERSIST-42";

        const workerAttempt = await fetch(`${server.url}/computers/worker/secrets/${encodeURIComponent(request.id)}/supply`, {
            method: "POST",
            headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
            body: JSON.stringify({ actorId: "worker", value: secret }),
        });
        assert.equal(workerAttempt.status, 401);

        const operatorAttempt = await fetch(`${server.url}/operator/computers/worker/secrets/${encodeURIComponent(request.id)}/supply`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${operatorSession.token}`,
                origin: server.url,
                "content-type": "application/json",
            },
            body: JSON.stringify({ actorId: "operator-console-security-review", value: secret }),
        });
        assert.equal(operatorAttempt.status, 200);
        assert.equal((await operatorAttempt.text()).includes(secret), false);

        for (const serialized of [
            JSON.stringify(await runtime.audit.readAll()),
            JSON.stringify(await runtime.orchestrator.listTasks()),
            JSON.stringify(await runtime.orchestrator.listTaskEvents(task.id)),
            JSON.stringify(await runtime.memory.search({ limit: 100 })),
        ])
            assert.equal(serialized.includes(secret), false);
    }
    finally {
        await server?.close();
        await runningPromise?.catch(() => undefined);
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});

test("live broad allow policy cannot override metadata/egress hard safety", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-security-hard-deny-"));
    const drivers = createMemoryComputerDriverFactory();
    let runtime;
    try {
        const initialPolicy = {
            repeatWindowMs: 180_000,
            repeatMaxActiveFingerprints: 10_000,
            rules: [
                { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                { id: "allow-snapshot", effect: "allow", match: { category: "computer", operation: "snapshot" } },
            ],
        };
        runtime = await createRuntime({
            dataDir,
            bindHost: "127.0.0.1",
            port: 0,
            computer: { allowPrivateHosts: true },
            agents: [{ id: "worker", name: "Worker", role: "worker", capabilities: [], harness: { kind: "echo" } }],
            policy: initialPolicy,
        }, { computerDriverFactory: drivers, bindComputerToTasks: false });

        const broadPolicy = {
            repeatWindowMs: 180_000,
            repeatMaxActiveFingerprints: 10_000,
            rules: [
                { id: "allow-harness", effect: "allow", match: { category: "harness" } },
                { id: "allow-all-computer", effect: "allow", match: { category: "computer" } },
            ],
        };
        const dryRunAction = {
            category: "computer",
            operation: "navigate",
            intent: "navigate",
            target: "https://example.com/",
            page: { url: "https://example.com/", host: "example.com" },
            agentId: "worker",
            taskId: "security-release-review",
        };
        await runtime.policyManager.apply({
            policy: broadPolicy,
            checks: [{ action: dryRunAction, repeatCount: 1, expect: { allowed: true, ruleId: "allow-all-computer" } }],
            actor: "security-release-review",
            label: "broad allow must not bypass hard safety",
        });

        await runtime.computer.navigate("worker", "security-release-review", "http://127.0.0.1:3000/explicit-private-setting");
        await assert.rejects(
            () => runtime.computer.navigate("worker", "security-release-review", "http://169.254.169.254/latest/meta-data"),
            /metadata/,
        );
        await assert.rejects(
            () => runtime.computer.navigate("worker", "security-release-review", "https://user:password@example.com/"),
            /credentials/,
        );

        const queryCanary = "release-query-secret-DO-NOT-AUDIT-42";
        await runtime.computer.navigate("worker", "security-release-review", `https://example.com/path?token=${queryCanary}#fragment`);
        assert.equal(JSON.stringify(await runtime.audit.readAll()).includes(queryCanary), false);

        assert.equal(isUnsafeAddress("169.254.1.1"), true);
        assert.equal(isUnsafeAddress("224.0.0.1"), true);
        assert.equal(isUnsafeAddress("::1"), true);
        await assert.rejects(
            () => resolveEgressTarget("169.254.169.254", { allowPrivateHosts: true }),
            /metadata/,
        );
    }
    finally {
        await runtime?.close();
        await rm(dataDir, { recursive: true, force: true });
    }
});
