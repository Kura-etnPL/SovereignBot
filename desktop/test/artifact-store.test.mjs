import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ARTIFACTS_SCHEMA, createArtifactStore } from "../src/main/artifact-store.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-artifacts-"));
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "reports"), { recursive: true });
    let seq = 0;
    const store = createArtifactStore({
        dataDir: join(root, "data"),
        makeArtifactId: () => `artifact_${String(++seq).padStart(16, "0")}`,
        now: () => "2026-08-26T00:00:00.000Z",
    });
    return { root, workspace, store };
}

test("artifact store copies trusted workspace output into durable managed storage", () => {
    const { root, workspace, store } = fixture();
    try {
        const source = join(workspace, "reports", "result.md");
        writeFileSync(source, "# Result\n\nUseful output.\n", "utf8");
        const artifact = store.ingestWorkspaceFile({
            workspaceId: "workspace_project",
            workspacePath: workspace,
            relativePath: "reports/result.md",
            title: "Research result",
            createdByCoworkerId: "coworker_1234567890abcdef",
            conversationId: "conv_1234567890abcdef",
            sourceMessageId: "msg_1234567890abcdef",
        });
        assert.equal(artifact.id, "artifact_0000000000000001");
        assert.equal(artifact.title, "Research result");
        assert.equal(artifact.mimeType, "text/markdown");
        assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(artifact, "storageRelativePath"), false);
        assert.equal(Object.hasOwn(artifact, "sourceRelativePath"), false);
        assert.equal(readFileSync(store.managedPath(artifact.id), "utf8"), "# Result\n\nUseful output.\n");
        const preview = store.previewText(artifact.id);
        assert.equal(preview.preview.includes("Useful output"), true);
        assert.equal(preview.truncated, false);
        assert.equal(store.list({ conversationId: "conv_1234567890abcdef" }).artifacts.length, 1);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("artifact ingestion refuses absolute/traversal paths, workspace escape and symlink sources", () => {
    const { root, workspace, store } = fixture();
    try {
        writeFileSync(join(root, "outside.txt"), "outside", "utf8");
        writeFileSync(join(workspace, "inside.txt"), "inside", "utf8");
        for (const relativePath of ["../outside.txt", "/etc/passwd", "C:/Windows/win.ini", "reports/../inside.txt", "./inside.txt"]) {
            assert.throws(() => store.ingestWorkspaceFile({ workspaceId: "workspace_project", workspacePath: workspace, relativePath }), /artifact path|unsafe|relative/);
        }
        try {
            symlinkSync(join(workspace, "inside.txt"), join(workspace, "linked.txt"));
            assert.throws(() => store.ingestWorkspaceFile({ workspaceId: "workspace_project", workspacePath: workspace, relativePath: "linked.txt" }), /symbolic link/);
        }
        catch (error) {
            // Windows CI may deny symlink creation; only skip the setup permission error.
            if (!/EPERM|privilege/i.test(String(error?.message ?? error))) throw error;
        }
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("artifact state reloads from its versioned metadata without exposing managed paths", () => {
    const { root, workspace, store } = fixture();
    try {
        writeFileSync(join(workspace, "data.json"), '{"ok":true}', "utf8");
        const artifact = store.ingestWorkspaceFile({ workspaceId: "workspace_project", workspacePath: workspace, relativePath: "data.json" });
        const reloaded = createArtifactStore({ dataDir: join(root, "data") });
        assert.equal(reloaded.schema, ARTIFACTS_SCHEMA);
        assert.equal(reloaded.get(artifact.id).fileName, "data.json");
        assert.equal(reloaded.previewText(artifact.id).preview, '{"ok":true}');
        assert.equal(Object.hasOwn(reloaded.get(artifact.id), "storageRelativePath"), false);
        assert.equal(Object.hasOwn(reloaded.get(artifact.id), "sourceRelativePath"), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
