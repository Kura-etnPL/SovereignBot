import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMemoryComputerDriverFactory } from "../../src/computer-driver.js";
import { createRuntime } from "../../src/runtime.js";
import { coworkerAgentId, coworkerCapability } from "../src/main/provider-roster.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createSkillStore } from "../src/main/skill-store.js";
import { createTeachOnceController } from "../src/main/teach-once-controller.js";
import { createTeachOnceRuntime } from "../src/main/teach-once-runtime.js";

function tempRoot(prefix) {
    const base = process.env.SOVEREIGNBOT_TEST_TMP_ROOT ?? tmpdir();
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
}

test("Teach Once production runtime uses the Coworker provider task and TaskBound Computer path", async () => {
    const root = tempRoot("sovereign-teach-once-runtime-");
    const coworkerId = "coworker_0000000000000001";
    const agentId = coworkerAgentId(coworkerId);
    const fixture = fileURLToPath(new URL("../../tests/fixtures/fake-teach-once-provider.mjs", import.meta.url));
    let runtime;
    try {
        const desktopState = join(root, "desktop-state");
        mkdirSync(desktopState, { recursive: true });
        const coworkers = createCoworkerStore({ persistPath: join(desktopState, "coworkers.json"), makeId: () => coworkerId });
        coworkers.create({ name: "Browser Specialist", role: "Prepare browser work", instructions: "Use semantic targets." });
        const skills = createSkillStore({ persistPath: join(desktopState, "skills.json"), makeSkillId: () => "skill_0000000000000001" });
        const driverFactory = createMemoryComputerDriverFactory();
        runtime = await createRuntime({
            dataDir: root,
            bindHost: "127.0.0.1",
            port: 0,
            computer: { allowPrivateHosts: false },
            agents: [
                { id: "planner", name: "Planner", role: "supervisor", capabilities: ["planning"], harness: { kind: "echo" } },
                {
                    id: agentId,
                    name: "Browser Specialist · Codex",
                    role: "worker",
                    capabilities: ["general", coworkerCapability(coworkerId)],
                    harness: { kind: "command", command: process.execPath, args: [fixture], timeoutMs: 10_000 },
                },
            ],
            policy: {
                rules: [
                    { id: "allow-coworker-harness", effect: "allow", match: { category: "harness", operation: "run", agentId } },
                    { id: "allow-coworker-computer", effect: "allow", match: { category: "computer", agentId } },
                ],
            },
        }, { computerDriverFactory: driverFactory });

        const computerRecord = (await runtime.computerRegistry.list()).find((entry) => entry.agentId === agentId);
        driverFactory.forComputer(computerRecord).setPage("https://example.com", [
            { ref: "button-initial", role: "button", name: "Create report", type: "button" },
            { ref: "input-initial", role: "textbox", name: "Report period", type: "text" },
            { ref: "status-initial", role: "status", name: "Report is ready", type: "status" },
        ]);

        const services = { workspacePath: () => undefined };
        const roster = () => ({
            roles: { planner: "planner" },
            coworkerBindings: {
                [coworkerId]: { ready: true, agentId, provider: "codex", profile: "efficient", harnessKind: "command" },
            },
        });
        const runtimeBridge = createTeachOnceRuntime({ dataDir: root, runtime, roster, coworkerStore: coworkers, services });
        const controller = createTeachOnceController({
            dataDir: root,
            coworkerStore: coworkers,
            skillStore: skills,
            rawComputer: runtime.rawComputer,
            getAgentId: () => agentId,
            generateDraft: runtimeBridge.generateDraft,
            testExecutor: runtimeBridge.testExecutor,
            makeId: () => "teach_0000000000000001",
        });

        const session = controller.start({ coworkerId, name: "Prepare report", description: "Create a report from the current site." });
        const screen = await controller.snapshot(session.id);
        await controller.recordAction(session.id, { kind: "click", ref: screen.elements[0].ref, target: "Create report" });
        await controller.recordAction(session.id, { kind: "type", ref: screen.elements[1].ref, target: "Report period", inputName: "report_period", text: "2026-Q3-secret-demo", sensitive: true });
        await controller.recordAction(session.id, { kind: "assert", target: "report status", validator: "contains", expectedOutput: "Report is ready" });

        const generated = await controller.finish(session.id);
        assert.equal(generated.generation.mode, "coworker-model");
        assert.equal(generated.draft.name, "Prepare report");

        const afterGeneration = await runtime.orchestrator.listTasks();
        const synthesisTask = afterGeneration.find((task) => task.title === "synthesize Teach Once SkillDraft");
        assert.equal(synthesisTask?.status, "completed");
        assert.doesNotMatch(JSON.stringify(synthesisTask.input), /2026-Q3-secret-demo|snapshot|"ref"/i);
        assert.equal(typeof synthesisTask.result.text, "string");

        const tested = await controller.test(session.id);
        assert.equal(tested.ok, true);
        assert.equal(tested.mode, "governed-computer");
        assert.equal(tested.checks.length, 3);
        const afterTest = await runtime.orchestrator.listTasks();
        const testTask = afterTest.find((task) => task.title === "run governed Teach Once Skill test");
        assert.equal(testTask?.status, "completed");
        assert.equal(testTask.result.ok, true);
        assert.ok(afterTest.some((task) => task.kind === "plan" && task.status === "completed"));

        const driverActions = driverFactory.get(agentId).actions();
        assert.ok(driverActions.some((action) => action.operation === "click"));
        assert.ok(driverActions.some((action) => action.operation === "type"));
        assert.ok(driverActions.filter((action) => action.operation === "snapshot").length >= 4);
        const audit = await runtime.audit.readAll();
        assert.ok(audit.some((record) => record.type === "computer.action_succeeded"), "replay must pass through the Governor Computer boundary");
        assert.doesNotMatch(JSON.stringify(audit), /2026-Q3-secret-demo|token=never-persist-this/);
        assert.equal(controller.get(session.id).state, "tested");
    }
    finally {
        await runtime?.close();
        rmSync(root, { recursive: true, force: true });
    }
});
