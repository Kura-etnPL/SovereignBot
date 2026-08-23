import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computerIdentityKey } from "../src/computer-migration.js";
import { createRuntime } from "../src/runtime.js";
import { preflightRuntimeStartup } from "../src/startup-preflight.js";
import {
    AGENT_IDS,
    LEGACY_TOKEN_A,
    LEGACY_TOKEN_B,
    MIGRATION_ID,
    assertMigratedComputer,
    migrationPlan,
    moveLegacyDirectory,
    pathExists,
    persistMarker,
    runtimeConfig,
    seedLegacyComputer,
} from "./computer-migration-fixtures.js";

async function assertRuntimeRecovered(dataDir, agentIds = AGENT_IDS) {
    const config = runtimeConfig(dataDir, agentIds);
    await preflightRuntimeStartup(config);
    const runtime = await createRuntime(config);
    try {
        await assertMigratedComputer(join(dataDir, "computers"), agentIds);
        assert.equal((await runtime.computerRegistry.credentials(agentIds[0])).token, LEGACY_TOKEN_A);
        if (agentIds[1])
            assert.equal((await runtime.computerRegistry.credentials(agentIds[1])).token, LEGACY_TOKEN_B);
        assert.equal((await runtime.computerRegistry.control(agentIds[0])).mode, "human");
    }
    finally {
        await runtime.close();
    }
}

test("computer migration recovers idempotently from each durable crash window", async () => {
    for (const crashWindow of ["marker-only", "stage", "partial-directories", "all-directories", "state-committed"]) {
        const root = await mkdtemp(join(tmpdir(), `sovereign-computer-migration-${crashWindow}-`));
        const dataDir = join(root, "data");
        try {
            const computers = await seedLegacyComputer(dataDir);
            const plan = await migrationPlan(computers);
            await persistMarker(plan, { stage: crashWindow !== "marker-only" });

            if (["partial-directories", "all-directories", "state-committed"].includes(crashWindow))
                await moveLegacyDirectory(computers, AGENT_IDS[0]);
            if (["all-directories", "state-committed"].includes(crashWindow))
                await moveLegacyDirectory(computers, AGENT_IDS[1]);
            if (crashWindow === "state-committed")
                await rename(plan.stagePath, plan.statePath);

            await assertRuntimeRecovered(dataDir);
            // A second restart must be a no-op migration-wise and must preserve credentials/state.
            await assertRuntimeRecovered(dataDir);
        }
        finally {
            await rm(root, { recursive: true, force: true });
        }
    }
});

test("legacy computer directories without state.json still migrate transactionally", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-no-state-"));
    const dataDir = join(root, "data");
    try {
        const computers = await seedLegacyComputer(dataDir, { withState: false });
        const plan = await migrationPlan(computers);
        assert.equal(plan.marker.sourceStateMissing, true);
        await persistMarker(plan, { stage: false });
        await moveLegacyDirectory(computers, AGENT_IDS[0]);

        await assertRuntimeRecovered(dataDir);
        const state = JSON.parse(await readFile(join(computers, "state.json"), "utf8"));
        assert.deepEqual(state, { version: 2, agents: {} });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("pre-marker v2 state with remaining legacy directories is wrapped in a new transaction and completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-v2-old-dirs-"));
    const dataDir = join(root, "data");
    try {
        const computers = await seedLegacyComputer(dataDir);
        const plan = await migrationPlan(computers);
        await rename(join(computers, AGENT_IDS[0]), join(computers, computerIdentityKey(AGENT_IDS[0])));
        await rename(join(computers, AGENT_IDS[1]), join(computers, computerIdentityKey(AGENT_IDS[1])));
        await rename(plan.stagePath, plan.statePath).catch(() => undefined);
        // Create exact target v2 state without a transaction marker to model a crash from the pre-v1 transaction era.
        await unlink(plan.markerPath).catch(() => undefined);
        await (await import("node:fs/promises")).writeFile(plan.statePath, plan.inspection.targetStateText, "utf8");
        // Put one directory back to legacy to model a partially renamed old migration.
        await rename(join(computers, computerIdentityKey(AGENT_IDS[1])), join(computers, AGENT_IDS[1]));

        await assertRuntimeRecovered(dataDir);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("committed marker cleanup is recoverable without generating new credentials first", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-committed-marker-"));
    const dataDir = join(root, "data");
    try {
        const computers = await seedLegacyComputer(dataDir);
        const plan = await migrationPlan(computers);
        await persistMarker(plan, { stage: true });
        for (const agentId of AGENT_IDS)
            await moveLegacyDirectory(computers, agentId);
        await rename(plan.stagePath, plan.statePath);
        assert.equal(await pathExists(plan.markerPath), true);
        assert.equal(await pathExists(join(computers, "operator-token")), false);

        await assertRuntimeRecovered(dataDir);
        assert.equal(await pathExists(plan.markerPath), false);
        assert.equal(await pathExists(join(computers, "operator-token")), true);
        void MIGRATION_ID;
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
