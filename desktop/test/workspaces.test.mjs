import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeWorkspacePath, createWorkspaceStore } from "../src/main/lib/workspaces.js";

test("canonicalization accepts real existing directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-ws-"));
    const real = canonicalizeWorkspacePath(dir);
    assert.equal(existsSync(real), true);
    assert.equal(statSync(real).isDirectory(), true);
});

test("canonicalization rejects unsafe inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-ws-"));
    const filePath = join(dir, "file.txt");
    writeFileSync(filePath, "x");

    const cases = [
        ["relative/path", /absolute/],
        ["bad\0path", /NUL/],
        [join(tmpdir(), "definitely-missing-ws"), /does not exist/],
        [filePath, /must be a directory/],
    ];
    if (process.platform === "win32")
        cases.push(["C:\\", /drive roots/]);
    else
        cases.push(["/", /filesystem root/]);
    for (const [bad, pattern] of cases)
        assert.throws(() => canonicalizeWorkspacePath(bad), pattern, bad);
});

test("store registers idempotently and manages defaults through explicit canonicalizer", () => {
    const identities = new Map([
        ["E:/workspaces/Demo", "E:/workspaces/Demo"],
        ["E:/other/ws2", "E:/other/ws2"],
    ]);
    let seq = 0;
    const store = createWorkspaceStore({
        now: () => "2026-08-24T00:00:00Z",
        makeId: () => `ws_test_${++seq}`,
    });

    const first = store.add("E:/workspaces/Demo", (value) => identities.get(String(value)));
    assert.equal(first.added, true);
    assert.equal(store.snapshot().defaultWorkspaceId, first.workspace.id);

    // Same path (case-insensitive) does not mint a second workspace.
    const duplicate = store.add("E:/WORKSPACES/demo", (value) => identities.get("E:/workspaces/Demo"));
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.workspace.id, first.workspace.id);
    assert.equal(store.snapshot().workspaces.length, 1);

    const second = store.add("E:/other/ws2", (value) => identities.get(String(value)));
    assert.equal(second.added, true);
    assert.equal(store.setDefault(second.workspace.id), true);
    assert.equal(store.defaultPath(), "E:/other/ws2");

    assert.equal(store.byId(first.workspace.id)?.path, "E:/workspaces/Demo");
    assert.equal(store.byId("ws_missing"), undefined);

    assert.equal(store.remove("ws_missing"), false);
    assert.throws(() => store.setDefault("ws_missing"), /unknown workspace id/);

    // Removing the default falls back to the first remaining registration.
    assert.equal(store.remove(second.workspace.id), true);
    assert.equal(store.snapshot().defaultWorkspaceId, first.workspace.id);
});
