import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";

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
