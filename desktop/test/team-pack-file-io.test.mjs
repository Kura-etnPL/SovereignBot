import assert from "node:assert/strict";
import test from "node:test";
import { exportTeamPackViaDialog, importTeamPackViaDialog, TEAM_PACK_FILE_MAX_BYTES } from "../src/main/team-pack-file-io.js";

const pack = {
    schema: "sovereignbot.desktop.team-pack.v1",
    id: "demo-pack",
    name: "Demo Team",
    description: "A bounded demo team.",
    coworkers: [
        { key: "chief", name: "Chief", role: "Coordinate", instructions: "Coordinate the work.", modelBinding: { profile: "automatic" } },
        { key: "reviewer", name: "Reviewer", role: "Review", instructions: "Review the result.", modelBinding: { profile: "efficient", provider: "codex", model: "luna" } },
    ],
    channels: [{ key: "project", name: "Project Channel", kind: "project", instructions: "A bounded project room.", playbookId: "delivery" }],
    playbooks: [{ id: "delivery", name: "Delivery", description: "Coordinate and review.", steps: ["chief", "reviewer"] }],
};

test("Team Pack file export writes bounded JSON and returns only the basename", async () => {
    let saved;
    const result = await exportTeamPackViaDialog({
        dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\P20 Team.json" }) },
        resolvePack: async () => pack,
        writeFileFn: async (path, text, options) => { saved = { path, text, options }; },
    });
    assert.deepEqual(result, { canceled: false, fileName: "P20 Team.json", bytes: Buffer.byteLength(saved.text, "utf8") });
    assert.equal(saved.options.encoding, "utf8");
    assert.deepEqual(JSON.parse(saved.text), pack);
    assert.equal(result.fileName.includes("E:"), false);
});

test("Team Pack file import validates the file at the authority boundary", async () => {
    let imported;
    const result = await importTeamPackViaDialog({
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["E:\\private\\demo.json"] }) },
        readFileFn: async () => Buffer.from(JSON.stringify(pack), "utf8"),
        importPack: async (value) => { imported = value; return { imported: true }; },
    });
    assert.deepEqual(result, { canceled: false, fileName: "demo.json", imported: true });
    assert.deepEqual(imported, pack);

    await assert.rejects(
        () => importTeamPackViaDialog({
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["unsafe.json"] }) },
            readFileFn: async () => Buffer.from(JSON.stringify({ ...pack, capabilityGrant: "computer" }), "utf8"),
            importPack: async () => assert.fail("unsafe pack reached the domain import"),
        }),
        /not accepted from the renderer/,
    );
});

test("Team Pack file import fails closed for cancellation, invalid JSON, and oversized files", async () => {
    await assert.deepEqual(
        await importTeamPackViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: true }) } }),
        { canceled: true },
    );
    await assert.deepEqual(
        await exportTeamPackViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: true }) }, resolvePack: async () => pack }),
        { canceled: true },
    );
    await assert.rejects(
        () => importTeamPackViaDialog({
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["bad.json"] }) },
            readFileFn: async () => Buffer.from("{bad", "utf8"),
            importPack: async () => assert.fail("invalid JSON reached the domain import"),
        }),
        /not valid JSON/,
    );
    await assert.rejects(
        () => importTeamPackViaDialog({
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["large.json"] }) },
            readFileFn: async () => Buffer.alloc(TEAM_PACK_FILE_MAX_BYTES + 1, 0x20),
            importPack: async () => assert.fail("oversized file reached the domain import"),
        }),
        /exceeds 65536 bytes/,
    );
    await assert.rejects(
        () => importTeamPackViaDialog({
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["E:\\\\private\\\\missing.json"] }) },
            readFileFn: async () => { throw new Error("ENOENT E:\\\\private\\\\missing.json"); },
            importPack: async () => assert.fail("read failure reached the domain import"),
        }),
        (error) => error.message === "Could not read the selected Team Pack file" && !error.message.includes("E:"),
    );
    await assert.rejects(
        () => exportTeamPackViaDialog({
            dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\\\private\\\\output.json" }) },
            resolvePack: async () => pack,
            writeFileFn: async () => { throw new Error("EACCES E:\\\\private\\\\output.json"); },
        }),
        (error) => error.message === "Could not save the Team Pack file" && !error.message.includes("E:"),
    );
});
