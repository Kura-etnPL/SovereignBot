import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    computerIdentityKey,
    computerLegacySegment,
    inspectComputerMigration,
    migrateComputerRegistry,
} from "../src/computer-migration.js";
import { preflightRuntimeStartup } from "../src/startup-preflight.js";
import {
    AGENT_IDS,
    migrationPlan,
    pathExists,
    persistMarker,
    runtimeConfig,
    seedLegacyComputer,
    writeJson,
} from "./computer-migration-fixtures.js";

test("configured agent set change while migration marker exists fails closed without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-agent-set-"));
    const dataDir = join(root, "data");
    try {
        const computers = await seedLegacyComputer(dataDir);
        const plan = await migrationPlan(computers);
        await persistMarker(plan, { stage: true });
        const markerBefore = await readFile(plan.markerPath, "utf8");
        const stageBefore = await readFile(plan.stagePath, "utf8");

        await assert.rejects(
            () => preflightRuntimeStartup(runtimeConfig(dataDir, [...AGENT_IDS, "worker-c"])),
            /computer migration marker does not match the current configured agent set/,
        );
        assert.equal(await readFile(plan.markerPath, "utf8"), markerBefore);
        assert.equal(await readFile(plan.stagePath, "utf8"), stageBefore);
        for (const agentId of AGENT_IDS)
            assert.equal(await pathExists(join(computers, computerLegacySegment(agentId))), true);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("migration marker and staged-state tamper fail closed", async () => {
    for (const mode of ["marker", "stage"]) {
        const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-tamper-"));
        const dataDir = join(root, "data");
        try {
            const computers = await seedLegacyComputer(dataDir);
            const plan = await migrationPlan(computers);
            await persistMarker(plan, { stage: true });
            if (mode === "marker") {
                const marker = JSON.parse(await readFile(plan.markerPath, "utf8"));
                marker.targetStateSha256 = "f".repeat(64);
                await writeJson(plan.markerPath, marker);
            }
            else {
                await writeFile(plan.stagePath, "{\"version\":2,\"agents\":{}}\nTAMPERED\n", "utf8");
            }
            await assert.rejects(
                () => preflightRuntimeStartup(runtimeConfig(dataDir)),
                mode === "marker" ? /target hash does not match deterministic v2 state/ : /staged state hash mismatch/,
            );
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("legacy state with an unknown agent fails before marker creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-unknown-agent-"));
    try {
        const computers = await seedLegacyComputer(root, { agentIds: [AGENT_IDS[0]] });
        const statePath = join(computers, "state.json");
        const state = JSON.parse(await readFile(statePath, "utf8"));
        state["removed-agent"] = { control: { mode: "human", updatedAt: "2026-08-20T00:00:00.000Z" } };
        await writeJson(statePath, state);
        await assert.rejects(
            () => migrateComputerRegistry(computers, [AGENT_IDS[0]]),
            /legacy computer state contains an agent that is absent from current config/,
        );
        assert.equal(await pathExists(join(computers, "migration.json")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ambiguous legacy directory collision fails before transaction creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-collision-"));
    try {
        const agentIds = ["a/b", "a_2Fb"];
        const computers = join(root, "computers");
        await (await import("node:fs/promises")).mkdir(join(computers, computerLegacySegment(agentIds[0])), { recursive: true });
        await writeJson(join(computers, "state.json"), {
            [agentIds[0]]: { control: { mode: "agent", updatedAt: "2026-08-20T00:00:00.000Z" } },
            [agentIds[1]]: { control: { mode: "agent", updatedAt: "2026-08-20T00:00:00.000Z" } },
        });
        assert.equal(computerLegacySegment(agentIds[0]), computerLegacySegment(agentIds[1]));
        assert.notEqual(computerIdentityKey(agentIds[0]), computerIdentityKey(agentIds[1]));
        await assert.rejects(
            () => inspectComputerMigration(computers, agentIds),
            /legacy computer directory mapping is ambiguous/,
        );
        assert.equal(await pathExists(join(computers, "migration.json")), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("migration stage without a transaction marker is rejected", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-orphan-stage-"));
    const dataDir = join(root, "data");
    try {
        const computers = await seedLegacyComputer(dataDir);
        await writeFile(join(computers, "state.json.migration-computermig_22222222-2222-4222-8222-222222222222"), "{}\n", "utf8");
        await assert.rejects(
            () => preflightRuntimeStartup(runtimeConfig(dataDir)),
            /computer migration staged state exists without a transaction marker/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
