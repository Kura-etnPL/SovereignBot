import assert from "node:assert/strict";
import test from "node:test";
import { exportSkillViaDialog, importSkillViaDialog, SKILL_FILE_MAX_BYTES } from "../src/main/skill-file-io.js";

const skill = { schema: "sovereignbot.desktop.skill.v1", name: "Review", description: "A bounded review.", instructions: "Review the supplied result and report the outcome.", inputs: [{ name: "result", type: "string", description: "The result to review.", required: true }], steps: ["Inspect", "Report"], expectedOutput: "Review report", requestedCapabilities: ["workspace"], validators: ["result is present"], source: "manual" };

test("Skill native file IO is bounded, basename-only, and declarative", async () => {
    let saved;
    const exported = await exportSkillViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\Review.json" }) }, resolveSkill: async () => skill, writeFileFn: async (path, text, options) => { saved = { path, text, options }; } });
    assert.deepEqual(exported, { canceled: false, fileName: "Review.json", bytes: Buffer.byteLength(saved.text, "utf8") });
    assert.deepEqual(JSON.parse(saved.text), skill);
    assert.equal(saved.options.encoding, "utf8");
});

test("Skill native import validates schema and rejects authority fields before domain import", async () => {
    let imported;
    const result = await importSkillViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["E:\\private\\review.json"] }) }, readFileFn: async () => Buffer.from(JSON.stringify(skill), "utf8"), importSkill: async (value) => { imported = value; return { imported: true }; } });
    assert.deepEqual(result, { canceled: false, fileName: "review.json", imported: true });
    assert.deepEqual(imported, skill);
    await assert.rejects(() => importSkillViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["unsafe.json"] }) }, readFileFn: async () => Buffer.from(JSON.stringify({ ...skill, capabilityGrant: "computer" }), "utf8"), importSkill: async () => assert.fail("unsafe Skill reached the domain") }), /unsupported authority field/);
    await assert.rejects(() => importSkillViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["unsafe.json"] }) }, readFileFn: async () => Buffer.from(JSON.stringify({ ...skill, instructions: "Open https://private.invalid" }), "utf8"), importSkill: async () => assert.fail("unsafe Skill reached the domain") }), /private path/);
});

test("Skill native file IO fails closed on cancel, invalid JSON, oversized input, and write errors", async () => {
    assert.deepEqual(await importSkillViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: true }) } }), { canceled: true });
    assert.deepEqual(await exportSkillViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: true }) }, resolveSkill: async () => skill }), { canceled: true });
    await assert.rejects(() => importSkillViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["bad.json"] }) }, readFileFn: async () => Buffer.from("{bad", "utf8"), importSkill: async () => assert.fail("invalid JSON reached the domain") }), /not valid JSON/);
    await assert.rejects(() => importSkillViaDialog({ dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["large.json"] }) }, readFileFn: async () => Buffer.alloc(SKILL_FILE_MAX_BYTES + 1), importSkill: async () => assert.fail("oversized file reached the domain") }), /exceeds 65536 bytes/);
    await assert.rejects(() => exportSkillViaDialog({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "E:\\private\\out.json" }) }, resolveSkill: async () => skill, writeFileFn: async () => { throw new Error("EACCES E:\\private\\out.json"); } }), (error) => error.message === "Could not save the Skill file" && !error.message.includes("E:"));
});
