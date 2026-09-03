import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { exportArtifactViaDialog } from "../src/main/artifact-file-io.js";

test("artifact export copies managed bytes through a native save dialog", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-artifact-export-"));
    const source = join(root, "managed.md");
    const destination = join(root, "exported.md");
    await writeFile(source, "# Managed artifact\n", "utf8");
    const artifact = { id: "artifact_1234567890abcdef", title: "Release notes", fileName: "managed.md", version: 2 };
    const result = await exportArtifactViaDialog({
        artifactId: artifact.id,
        dialog: { showSaveDialog: async (_parent, options) => { assert.equal(options.defaultPath, "Release-notes.md"); return { canceled: false, filePath: destination }; } },
        artifactStore: { get: (id) => { assert.equal(id, artifact.id); return artifact; }, managedPath: (id) => { assert.equal(id, artifact.id); return source; } },
        lstatFn: async () => ({ isSymbolicLink: () => false }),
    });
    assert.deepEqual(result, { canceled: false, fileName: "exported.md", bytes: 19, artifactId: artifact.id, version: 2 });
    assert.equal(await readFile(destination, "utf8"), "# Managed artifact\n");
    assert.equal((await stat(source)).isFile(), true);
});

test("artifact export cancellation does not copy or expose a raw path", async () => {
    let copied = false;
    const result = await exportArtifactViaDialog({
        artifactId: "artifact_1234567890abcdef",
        dialog: { showSaveDialog: async () => ({ canceled: true }) },
        artifactStore: { get: () => ({ id: "artifact_1234567890abcdef", title: "Artifact", fileName: "artifact.txt" }), managedPath: () => "C:\\private\\managed.txt" },
        copyFileFn: async () => { copied = true; },
        lstatFn: async () => ({ isSymbolicLink: () => false }),
        statFn: async () => ({ isFile: () => true, size: 1 }),
    });
    assert.deepEqual(result, { canceled: true });
    assert.equal(copied, false);
    assert.doesNotMatch(JSON.stringify(result), /private|managed/);
});
