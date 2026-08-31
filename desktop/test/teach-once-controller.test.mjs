import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createSkillStore } from "../src/main/skill-store.js";
import { createTeachOnceController } from "../src/main/teach-once-controller.js";

function tempRoot(prefix) {
    const base = process.env.SOVEREIGNBOT_TEST_TMP_ROOT ?? tmpdir();
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
}

function validDraft() {
    return {
        name: "Prepare report",
        description: "Create a report from the current site.",
        instructions: "Use semantic Computer actions and verify the visible result.",
        inputs: [{ name: "report_period", type: "string", description: "Report period.", required: true }],
        steps: [
            "Click the Create report button.",
            "Enter {{input:report_period}} into Report period.",
            "Verify that Report is ready.",
        ],
        expectedOutput: "Report is ready",
        requestedCapabilities: ["computer"],
        validators: ["contains: Report is ready"],
    };
}

test("Teach Once performs governed semantic actions and saves a reusable, redacted Skill", async () => {
    const root = tempRoot("sovereign-teach-once-");
    const coworkerId = "coworker_0000000000000001";
    let now = 1_756_800_000_000;
    const coworkers = createCoworkerStore({
        persistPath: join(root, "coworkers.json"),
        makeId: () => coworkerId,
        now: () => new Date(now).toISOString(),
    });
    coworkers.create({ name: "Browser Specialist", role: "Prepare browser work", instructions: "Use semantic targets." });
    const skills = createSkillStore({
        persistPath: join(root, "skills.json"),
        makeSkillId: () => "skill_0000000000000001",
        now: () => new Date(now).toISOString(),
    });
    const calls = [];
    const rawComputer = {
        async snapshot(agentId, taskId) {
            calls.push(["snapshot", agentId, taskId]);
            return {
                snapshotId: `snapshot_${String(calls.filter(([kind]) => kind === "snapshot").length + 1).padStart(16, "0")}`,
                url: "https://example.com/private/report?token=never-persist-this",
                elements: [
                    { ref: `button-${calls.length}`, role: "button", name: "Create report", type: "button" },
                    { ref: `input-${calls.length}`, role: "textbox", name: "Report period", type: "text" },
                    { ref: `status-${calls.length}`, role: "status", name: "Report is ready", type: "status" },
                ],
            };
        },
        async navigate(agentId, taskId, url) { calls.push(["navigate", agentId, taskId, url]); return { url }; },
        async click(agentId, taskId, input) { calls.push(["click", agentId, taskId, input]); return { clicked: true }; },
        async type(agentId, taskId, input) { calls.push(["type", agentId, taskId, input]); return { typed: true }; },
        async key(agentId, taskId, input) { calls.push(["key", agentId, taskId, input]); return { pressed: true }; },
        async scroll(agentId, taskId, input) { calls.push(["scroll", agentId, taskId, input]); return { scrolled: true }; },
    };
    let generationInput;
    try {
        const controller = createTeachOnceController({
            dataDir: root,
            coworkerStore: coworkers,
            skillStore: skills,
            rawComputer,
            getAgentId: (id) => id === coworkerId ? "agent-browser-specialist" : undefined,
            generateDraft: async ({ session, coworker }) => {
                generationInput = { session, coworker };
                return validDraft();
            },
            testExecutor: ({ execute, agentId, signal }) => execute({
                computer: rawComputer,
                agentId,
                taskId: "task_governed_teach_once",
                signal,
            }),
            now: () => now,
            makeId: () => "teach_0000000000000001",
        });
        let session = controller.start({ coworkerId, name: "Prepare report", description: "Create a report from the current site." });
        const screen = await controller.snapshot(session.id);
        assert.equal(screen.site, "example.com");
        assert.equal(screen.elements[0].name, "Create report");

        await controller.recordAction(session.id, { kind: "navigate", url: "https://example.com/private/report?secret=value", target: "report page" });
        const reportScreen = await controller.snapshot(session.id);
        await controller.recordAction(session.id, { kind: "click", snapshotId: reportScreen.snapshotId, ref: reportScreen.elements[0].ref, target: "Create report", app: "Example" });
        await controller.recordAction(session.id, { kind: "type", snapshotId: reportScreen.snapshotId, ref: reportScreen.elements[1].ref, target: "Report period", inputName: "report_period", text: "2026-Q3-secret-demo", sensitive: true });
        await controller.recordAction(session.id, { kind: "assert", target: "report status", validator: "contains", expectedOutput: "Report is ready" });

        const draftResult = await controller.finish(session.id);
        assert.equal(draftResult.generation.mode, "coworker-model");
        assert.equal(draftResult.draft.inputs[0].name, "report_period");
        assert.match(draftResult.draft.steps.join("\n"), /\{\{input:report_period\}\}/);
        assert.equal(generationInput.session.actions[1].text, undefined);
        assert.equal(generationInput.session.actions[0].ref, undefined);
        assert.doesNotMatch(JSON.stringify(generationInput), /2026-Q3-secret-demo/);
        const tested = await controller.test(session.id);
        assert.equal(tested.mode, "governed-computer");
        assert.equal(tested.ok, true);
        session = tested.session;
        const saved = controller.save(session.id);
        assert.equal(saved.skill.source, "taught");
        assert.deepEqual(saved.skill.requestedCapabilities, ["computer"]);
        assert.equal(saved.skill.steps.length, 3);

        const persisted = readFileSync(join(root, "desktop-state", "teach-once.json"), "utf8");
        assert.doesNotMatch(persisted, /2026-Q3-secret-demo/);
        assert.doesNotMatch(persisted, /token=never-persist-this/);
        assert.doesNotMatch(persisted, /snapshot_0000000000000001/);
        assert.doesNotMatch(persisted, /"ref"/);
        assert.equal(calls.filter(([kind]) => kind === "type")[0][3].text, "2026-Q3-secret-demo");
        assert.ok(calls.filter(([kind]) => kind === "snapshot").length >= 4, "test must refresh semantic snapshots during replay");
        assert.notEqual(calls.filter(([kind]) => kind === "click")[1][3].ref, reportScreen.elements[0].ref, "replay must bind a fresh semantic ref");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Teach Once rejects malformed model drafts and does not claim a test pass", async () => {
    const root = tempRoot("sovereign-teach-once-invalid-");
    const coworkerId = "coworker_0000000000000001";
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json"), makeId: () => coworkerId });
    coworkers.create({ name: "Worker", role: "Test", instructions: "" });
    const skills = createSkillStore({ persistPath: join(root, "skills.json") });
    const rawComputer = {
        snapshot: async () => ({ snapshotId: "snapshot_0000000000000001", elements: [{ ref: "e1", role: "button", name: "Run", type: "button" }] }),
        navigate: async () => ({}),
    };
    try {
        const controller = createTeachOnceController({
            dataDir: root,
            coworkerStore: coworkers,
            skillStore: skills,
            rawComputer,
            getAgentId: () => "agent",
            generateDraft: async () => ({ name: "invalid", instructions: "missing exact fields" }),
            makeId: () => "teach_0000000000000001",
        });
        const session = controller.start({ coworkerId, name: "Test", description: "" });
        await controller.recordAction(session.id, { kind: "assert", target: "Run", validator: "exists" });
        await assert.rejects(() => controller.finish(session.id), /invalid structured SkillDraft/);
        assert.equal(controller.get(session.id).state, "recording");
        assert.throws(() => controller.test(session.id), /create a draft first/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Teach Once keeps a manual validator pending instead of recording a false pass", async () => {
    const root = tempRoot("sovereign-teach-once-manual-");
    const coworkerId = "coworker_0000000000000001";
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json"), makeId: () => coworkerId });
    coworkers.create({ name: "Worker", role: "Test", instructions: "" });
    const skills = createSkillStore({ persistPath: join(root, "skills.json") });
    const rawComputer = {
        snapshot: async () => ({ snapshotId: "snapshot_0000000000000001", elements: [{ ref: "e1", role: "button", name: "Run", type: "button" }] }),
        navigate: async () => ({}),
    };
    try {
        const controller = createTeachOnceController({
            dataDir: root,
            coworkerStore: coworkers,
            skillStore: skills,
            rawComputer,
            getAgentId: () => "agent",
            generateDraft: async () => ({ ...validDraft(), validators: ["manual: confirm the result"] }),
            testExecutor: async () => ({ ok: false, status: "awaiting-confirmation", checks: [], validatorCount: 1 }),
            makeId: () => "teach_0000000000000001",
        });
        const session = controller.start({ coworkerId, name: "Test", description: "" });
        await controller.recordAction(session.id, { kind: "assert", target: "Run", validator: "manual" });
        await controller.finish(session.id);
        const pending = await controller.test(session.id);
        assert.equal(pending.status, "awaiting-confirmation");
        assert.equal(pending.session.state, "drafted");
        assert.equal(controller.get(session.id).testResult, undefined);
        assert.throws(() => controller.save(session.id), /test the skill draft/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Teach Once rejects absolute semantic targets and unbounded action shapes", async () => {
    const root = tempRoot("sovereign-teach-once-shape-");
    try {
        const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json"), makeId: () => "coworker_0000000000000001" });
        coworkers.create({ name: "Worker", role: "Test", instructions: "" });
        const skills = createSkillStore({ persistPath: join(root, "skills.json") });
        const controller = createTeachOnceController({
            dataDir: root,
            coworkerStore: coworkers,
            skillStore: skills,
            rawComputer: { snapshot: async () => ({ snapshotId: "snapshot_0000000000000001", elements: [] }), navigate: async () => ({}) },
            getAgentId: () => "agent",
            generateDraft: async () => validDraft(),
        });
        const session = controller.start({ coworkerId: "coworker_0000000000000001", name: "Test", description: "" });
        await assert.rejects(() => controller.recordAction(session.id, { kind: "assert", target: "C:\\private\\output.txt", validator: "exists" }), /semantic/);
        await assert.rejects(() => controller.recordAction(session.id, { kind: "wait", milliseconds: 10_001 }), /0-10000/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
