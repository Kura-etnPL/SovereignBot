import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createSkillStore } from "../src/main/skill-store.js";
import { createTeachOnceController } from "../src/main/teach-once-controller.js";

test("Teach Once performs governed semantic actions and saves a reusable, redacted Skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-teach-once-"));
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
                snapshotId: "snapshot_0000000000000001",
                url: "https://example.com/private/report?token=never-persist-this",
                elements: [{ ref: "e1", role: "button", name: "Create report", type: "button" }],
            };
        },
        async navigate(agentId, taskId, url) { calls.push(["navigate", agentId, taskId, url]); return { url }; },
        async click(agentId, taskId, input) { calls.push(["click", agentId, taskId, input]); return { clicked: true }; },
        async type(agentId, taskId, input) { calls.push(["type", agentId, taskId, input]); return { typed: true }; },
        async key(agentId, taskId, input) { calls.push(["key", agentId, taskId, input]); return { pressed: true }; },
        async scroll(agentId, taskId, input) { calls.push(["scroll", agentId, taskId, input]); return { scrolled: true }; },
    };
    try {
        const controller = createTeachOnceController({
            dataDir: root,
            coworkerStore: coworkers,
            skillStore: skills,
            rawComputer,
            getAgentId: (id) => id === coworkerId ? "agent-browser-specialist" : undefined,
            now: () => now,
            makeId: () => "teach_0000000000000001",
        });
        let session = controller.start({ coworkerId, name: "Prepare report", description: "Create a report from the current site." });
        const screen = await controller.snapshot(session.id);
        assert.equal(screen.site, "example.com");
        assert.equal(screen.elements[0].name, "Create report");

        await controller.recordAction(session.id, { kind: "navigate", url: "https://example.com/private/report?secret=value", target: "report page" });
        const reportScreen = await controller.snapshot(session.id);
        await controller.recordAction(session.id, { kind: "click", snapshotId: reportScreen.snapshotId, ref: "e1", target: "Create report", app: "Example" });
        await controller.recordAction(session.id, { kind: "type", snapshotId: reportScreen.snapshotId, ref: "e1", target: "Report period", inputName: "report_period", text: "2026-Q3-secret-demo", sensitive: true });
        await controller.recordAction(session.id, { kind: "assert", target: "report status", validator: "contains", expectedOutput: "Report is ready" });

        const draftResult = controller.finish(session.id);
        assert.equal(draftResult.draft.inputs[0].name, "report_period");
        assert.match(draftResult.draft.steps.join("\n"), /\{\{input:report_period\}\}/);
        const tested = controller.test(session.id);
        assert.equal(tested.ok, true);
        session = tested.session;
        const saved = controller.save(session.id);
        assert.equal(saved.skill.source, "taught");
        assert.deepEqual(saved.skill.requestedCapabilities, ["computer"]);
        assert.equal(saved.skill.steps.length, 4);

        const persisted = readFileSync(join(root, "desktop-state", "teach-once.json"), "utf8");
        assert.doesNotMatch(persisted, /2026-Q3-secret-demo/);
        assert.doesNotMatch(persisted, /token=never-persist-this/);
        assert.doesNotMatch(persisted, /snapshot_0000000000000001/);
        assert.doesNotMatch(persisted, /"ref"/);
        assert.equal(calls.filter(([kind]) => kind === "type")[0][3].text, "2026-Q3-secret-demo");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Teach Once rejects absolute semantic targets and unbounded action shapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "sovereign-teach-once-shape-"));
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
        });
        const session = controller.start({ coworkerId: "coworker_0000000000000001", name: "Test", description: "" });
        await assert.rejects(() => controller.recordAction(session.id, { kind: "assert", target: "C:\\private\\output.txt", validator: "exists" }), /semantic/);
        await assert.rejects(() => controller.recordAction(session.id, { kind: "wait", milliseconds: 10_001 }), /0-10000/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
