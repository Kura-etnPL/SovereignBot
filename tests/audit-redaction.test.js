import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { TaskEventStore } from "../src/task-events.js";
import { publicRuntimeRecords } from "../src/task-view.js";

test("audit redacts sensitive keys and secret-operation errors before hashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-audit-redaction-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    await audit.init();
    await audit.append({
        type: "computer.secret_supply_failed",
        actor: "operator",
        subject: "computer:worker",
        data: {
            error: "driver accidentally echoed SECRET-123",
            password: "SECRET-123",
            nested: { token: "SECRET-456", safe: "visible" },
        },
    });
    const [record] = await audit.readAll();
    assert.equal(record.data.error, "secret operation failed");
    assert.equal(record.data.password, "[REDACTED]");
    assert.equal(record.data.nested.token, "[REDACTED]");
    assert.equal(record.data.nested.safe, "visible");
    assert.equal(JSON.stringify(record).includes("SECRET-"), false);
    assert.equal((await audit.verify()).ok, true);
});

test("audit and task-event records omit provider continuity and private paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-runtime-redaction-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    const taskEvents = new TaskEventStore(dir);
    await audit.init();
    await taskEvents.init();

    const privatePath = "E:\\Eternal\\Auto_Empire\\private-workspace";
    const providerSession = "provider-session-do-not-log";
    await audit.append({
        type: "task.completed",
        actor: "worker",
        subject: "task-1",
        data: {
            harnessMetadata: { sessionId: providerSession, safe: "visible" },
            keys: ["kind", "sessionId", "executionContext"],
            cwd: privatePath,
            message: `finished in ${privatePath}`,
        },
    });
    await taskEvents.append({
        taskId: "task-1",
        type: "task.harness_state_updated",
        actor: "worker",
        data: {
            keys: ["kind", "sessionId", "harnessState"],
            sessionId: providerSession,
            workspacePath: privatePath,
        },
    });

    const auditText = JSON.stringify(await audit.readAll());
    const eventText = JSON.stringify(await taskEvents.list());
    assert.equal(auditText.includes(providerSession), false);
    assert.equal(eventText.includes(providerSession), false);
    assert.equal(auditText.includes(privatePath), false);
    assert.equal(eventText.includes(privatePath), false);
    assert.equal(auditText.includes('"sessionId":"[REDACTED]"'), true);
    assert.equal(auditText.includes('"sessionId":"provider-session-do-not-log"'), false);
    assert.equal(eventText.includes("sessionId"), false);
    assert.equal(auditText.includes("executionContext"), false);
    assert.equal(eventText.includes("harnessState"), false);
    assert.equal((await audit.verify()).ok, true);

    const publicText = JSON.stringify(publicRuntimeRecords([{
        type: "task.harness_state_updated",
        data: {
            sessionId: providerSession,
            workspacePath: privatePath,
            safe: "visible",
        },
    }], [{ harnessState: { kind: "codex", sessionId: providerSession } }]));
    assert.equal(publicText.includes(providerSession), false);
    assert.equal(publicText.includes(privatePath), false);
    assert.equal(publicText.includes("sessionId"), false);
    assert.equal(publicText.includes("workspacePath"), false);
    assert.equal(publicText.includes("visible"), true);
});
