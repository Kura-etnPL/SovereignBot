import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactStore } from "../src/main/artifact-store.js";

test("Artifact Hub and Search consume the bounded indexed interface", () => {
    const productSurface = readFileSync(new URL("../src/main/product-surface-service.js", import.meta.url), "utf8");
    const searchService = readFileSync(new URL("../src/main/search-service.js", import.meta.url), "utf8");
    assert.match(productSurface, /artifactStore\.indexRecords/);
    assert.match(searchService, /artifactStore\.indexRecords/);
    assert.doesNotMatch(readFileSync(new URL("../src/main/index.js", import.meta.url), "utf8"), /artifact:indexRecords/);
});

function metadata(id, { familyId = id, version = 1, conversationId, coworkerId, title = `P42 artifact ${id}`, createdAt = "2026-09-01T00:00:00.000Z" } = {}) {
    return {
        id,
        title,
        fileName: `${id}.md`,
        mimeType: "text/markdown",
        size: 1,
        sha256: "0".repeat(64),
        storageRelativePath: `${id}/${id}.md`,
        createdAt,
        artifactFamilyId: familyId,
        version,
        ...(conversationId ? { conversationId } : {}),
        ...(coworkerId ? { createdByCoworkerId: coworkerId } : {}),
        published: true,
        archived: false,
    };
}

test("ArtifactStore indexed records cover the bound, filters, mutations, and restart", () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-p42-index-"));
    const dataDir = join(root, "data");
    mkdirSync(join(dataDir, "desktop-state"), { recursive: true });
    const conversationId = "conv_1234567890abcdef";
    const coworkerId = "coworker_1234567890abcdef";
    const targetId = "artifact_0000000000000001";
    const latestId = "artifact_0000000000000002";
    const artifacts = [metadata(targetId, { familyId: targetId, conversationId, coworkerId, title: "P42 Indexed Target", version: 1 }), metadata(latestId, { familyId: targetId, conversationId, coworkerId, title: "P42 Indexed Target", version: 2 })];
    for (let index = 3; index <= 620; index += 1) artifacts.push(metadata(`artifact_${index.toString(16).padStart(16, "0")}`, { title: `P42 recent unrelated ${index}`, createdAt: `2026-09-03T00:00:${String(index % 60).padStart(2, "0")}.000Z` }));
    writeFileSync(join(dataDir, "desktop-state", "artifacts.json"), JSON.stringify({ schema: "sovereignbot.desktop.artifacts.v1", artifacts }), "utf8");
    try {
        const store = createArtifactStore({ dataDir });
        assert.equal(store.indexRecords({ visibility: "all", limit: 5_000 }).artifacts.length, 620);
        assert.deepEqual(store.indexRecords({ conversationId, visibility: "active", limit: 10 }).artifacts.map((entry) => entry.id), [latestId, targetId]);
        assert.equal(store.get(latestId).title, "P42 Indexed Target");
        assert.equal(store.list({ limit: 500 }).artifacts.length, 500);
        assert.throws(() => store.indexRecords({ limit: 5_001 }), /1\.\.5000/);
        assert.throws(() => store.indexRecords({ conversationIds: Array.from({ length: 65 }, () => conversationId) }), /at most 64/);
        assert.throws(() => store.indexRecords({ unexpected: true }), /unknown indexed artifact field/);
        store.archive(latestId);
        assert.equal(store.indexRecords({ conversationId, visibility: "active", limit: 10 }).artifacts.length, 0);
        assert.equal(store.indexRecords({ conversationId, visibility: "archived", limit: 10 }).artifacts.length, 2);
        store.restore(latestId);
        assert.deepEqual(store.history(latestId).history.map((entry) => entry.version), [2, 1]);
        const restarted = createArtifactStore({ dataDir });
        assert.deepEqual(restarted.indexRecords({ conversationId, visibility: "active", limit: 10 }).artifacts.map((entry) => entry.id), [latestId, targetId]);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
