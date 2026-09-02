import assert from "node:assert/strict";
import test from "node:test";
import { exportPlaybookViaDialog, importPlaybookViaDialog, PLAYBOOK_FILE_MAX_BYTES } from "../src/main/playbook-file-io.js";

const playbook = {
    schema: "sovereignbot.desktop.playbook.v1",
    id: "delivery",
    name: "Delivery Method",
    description: "A bounded method.",
    steps: ["chief", "reviewer"],
    stages: [{ id: "draft", name: "Draft", instructions: "Prepare the draft.", expectedOutput: "Draft" }],
    reviewPoints: [{ id: "review", name: "Review", instructions: "Review the draft." }],
    expectedOutput: "Approved result",
    recommendedCoworkerRoles: ["Author", "Reviewer"],
    recommendedSkillIds: ["skill_review"],
};

test("Playbook file export writes bounded JSON and returns only the basename", async () => {
    let saved;
    const result = await exportPlaybookViaDialog({
        dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\Delivery Method.json" }) },
        resolvePlaybook: async () => playbook,
        writeFileFn: async (path, text, options) => { saved = { path, text, options }; },
    });
    assert.deepEqual(result, { canceled: false, fileName: "Delivery Method.json", bytes: Buffer.byteLength(saved.text, "utf8") });
    assert.equal(saved.options.encoding, "utf8");
    assert.deepEqual(JSON.parse(saved.text), playbook);
    assert.equal(result.fileName.includes("E:"), false);
});

test("Playbook file import validates declarative schema before domain import", async () => {
    let imported;
    const result = await importPlaybookViaDialog({
        dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["E:\\private\\delivery.json"] }) },
        readFileFn: async () => Buffer.from(JSON.stringify(playbook), "utf8"),
        importPlaybook: async (value) => { imported = value; return { imported: true }; },
    });
    assert.deepEqual(result, { canceled: false, fileName: "delivery.json", imported: true });
    assert.deepEqual(imported, playbook);
    await assert.rejects(
        () => importPlaybookViaDialog({
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["unsafe.json"] }) },
            readFileFn: async () => Buffer.from(JSON.stringify({ ...playbook, token: "never" }), "utf8"),
            importPlaybook: async () => assert.fail("unsafe playbook reached the domain import"),
        }),
        /payload\.playbook\.token/,
    );
});

test("Playbook file IO fails closed for cancellation, invalid JSON, oversized files, and write errors", async () => {
    assert.deepEqual(await importPlaybookViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: true }) } }), { canceled: true });
    assert.deepEqual(await exportPlaybookViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: true }) }, resolvePlaybook: async () => playbook }), { canceled: true });
    await assert.rejects(
        () => importPlaybookViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["bad.json"] }) }, readFileFn: async () => Buffer.from("{bad", "utf8"), importPlaybook: async () => assert.fail("invalid JSON reached the domain import") }),
        /not valid JSON/,
    );
    await assert.rejects(
        () => importPlaybookViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["large.json"] }) }, readFileFn: async () => Buffer.alloc(PLAYBOOK_FILE_MAX_BYTES + 1, 0x20), importPlaybook: async () => assert.fail("oversized file reached the domain import") }),
        /exceeds 65536 bytes/,
    );
    await assert.rejects(
        () => exportPlaybookViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\out.json" }) }, resolvePlaybook: async () => playbook, writeFileFn: async () => { throw new Error("EACCES E:\\private\\out.json"); } }),
        (error) => error.message === "Could not save the Playbook file" && !error.message.includes("E:"),
    );
});
