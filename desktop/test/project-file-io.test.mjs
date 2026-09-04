import assert from "node:assert/strict";
import test from "node:test";
import { exportProjectViaDialog, PROJECT_FILE_MAX_BYTES } from "../src/main/project-file-io.js";

const project = { schema: "sovereignbot.project-export.v1", exportedAt: "2026-09-03T00:00:00.000Z", project: { name: "Local Project", state: "active", counts: { teams: 1 }, teams: [{ name: "Team", channels: [{ name: "Channel" }] }], coworkers: [{ name: "Chief" }], memory: [{ title: "Fact", content: "Safe content", tags: [], pinned: false }] } };

test("Project export writes bounded portable JSON and returns only the basename", async () => {
    let saved;
    const result = await exportProjectViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\Local Project.json" }) }, resolveProject: async () => project, writeFileFn: async (path, text, options) => { saved = { path, text, options }; } });
    assert.deepEqual(result, { canceled: false, fileName: "Local Project.json", bytes: Buffer.byteLength(saved.text, "utf8") });
    assert.equal(saved.options.encoding, "utf8");
    assert.deepEqual(JSON.parse(saved.text), project);
    assert.equal(result.fileName.includes("E:"), false);
});

test("Project export cancellation, oversize output, and save errors fail closed", async () => {
    assert.deepEqual(await exportProjectViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: true }) }, resolveProject: async () => project }), { canceled: true });
    await assert.rejects(() => exportProjectViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\out.json" }) }, resolveProject: async () => ({ project: { name: "Large" }, content: "x".repeat(PROJECT_FILE_MAX_BYTES) }) }), /exceeds 65536 bytes/);
    await assert.rejects(() => exportProjectViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\out.json" }) }, resolveProject: async () => project, writeFileFn: async () => { throw new Error("EACCES E:\\private\\out.json"); } }), (error) => error.message === "Could not save the Project file" && !error.message.includes("E:"));
});
