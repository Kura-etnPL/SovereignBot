import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOrCreateWorkerIdentity } from "../src/worker-node-identity.js";

test("concurrent Worker Node identity creation preserves one durable private identity", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sovereign-worker-identity-"));
    try {
        const identities = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateWorkerIdentity(dataDir, { name: "Concurrent Worker" })));
        assert.equal(new Set(identities.map((identity) => identity.nodeId)).size, 1);
        assert.equal(new Set(identities.map((identity) => identity.token)).size, 1);
        assert.equal(new Set(identities.map((identity) => identity.createdAt)).size, 1);
        const persisted = JSON.parse(await readFile(join(dataDir, "worker-node-identity.json"), "utf8"));
        assert.equal(persisted.nodeId, identities[0].nodeId);
        assert.equal(persisted.token, identities[0].token);
        assert.equal(persisted.name, "Concurrent Worker");
    }
    finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});
