import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory.js";
test("memory persists records and returns the latest value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-memory-"));
    const memory = new MemoryStore(join(dir, "memory.jsonl"));
    await memory.put({ scope: "agent:a", key: "preference", value: "first" });
    await memory.put({ scope: "agent:a", key: "preference", value: "latest", tags: ["profile"] });
    assert.equal((await memory.latest("agent:a", "preference"))?.value, "latest");
    assert.equal((await memory.search({ query: "latest" })).length, 1);
});
