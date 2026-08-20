import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/audit.js";
test("audit log is hash chained and detects tampering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-audit-"));
    const path = join(dir, "audit.jsonl");
    const audit = new AuditLog(path);
    await audit.init();
    await audit.append({ type: "one", actor: "test", data: { value: 1 } });
    await audit.append({ type: "two", actor: "test", data: { value: 2 } });
    assert.deepEqual(await audit.verify(), { ok: true, count: 2 });
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace('"value":1', '"value":9'), "utf8");
    const result = await audit.verify();
    assert.equal(result.ok, false);
});
