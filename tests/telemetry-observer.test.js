import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
import { TaskEventStore } from "../src/task-events.js";

test("throwing telemetry subscribers cannot fail durable task/audit appends", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-telemetry-observer-"));
    const taskEvents = new TaskEventStore(dataDir);
    await taskEvents.init();
    const audit = new AuditLog(join(dataDir, "audit.jsonl"));
    await audit.init();

    taskEvents.subscribe(() => {
        throw new Error("observer task failure");
    });
    audit.subscribe(() => {
        throw new Error("observer audit failure");
    });

    const task = await taskEvents.append({
        taskId: "task-observer",
        type: "task.progress",
        actor: "worker",
        data: { percent: 50 },
    });
    const record = await audit.append({
        type: "task.progress_observed",
        actor: "worker",
        subject: "task-observer",
        data: { percent: 50 },
    });

    assert.equal(task.duplicate, false);
    assert.equal(task.event.type, "task.progress");
    assert.equal(record.type, "task.progress_observed");
    assert.equal((await taskEvents.list("task-observer")).length, 1);
    assert.equal((await audit.verify()).ok, true);
});

test("operator UI telemetry source does not put the session token in a URL", async () => {
    const source = await readFile(new URL("../ui/app.js", import.meta.url), "utf8");
    assert.match(source, /fetch\("\/operator\/stream"/);
    assert.match(source, /authorization:\s*`Bearer \$\{token\}`/);
    assert.doesNotMatch(source, /operator\/stream\?[^\n]*token/i);
    assert.doesNotMatch(source, /new EventSource/i);
});
