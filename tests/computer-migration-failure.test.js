import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
    computerIdentityKey,
    computerLegacySegment,
    migrateComputerRegistry,
} from "../src/computer-migration.js";
import { ComputerRegistry } from "../src/computer-registry.js";
import {
    AGENT_IDS,
    LEGACY_TOKEN_A,
    pathExists,
    seedLegacyComputer,
} from "./computer-migration-fixtures.js";

async function migrationArtifacts(root) {
    return (await readdir(root)).filter((name) => name === "migration.json" || name.startsWith("state.json.migration-"));
}

async function assertLegacyLayout(root) {
    for (const agentId of AGENT_IDS) {
        assert.equal(await pathExists(join(root, computerLegacySegment(agentId))), true, agentId);
        assert.equal(await pathExists(join(root, computerIdentityKey(agentId))), false, agentId);
    }
    assert.deepEqual(await migrationArtifacts(root), []);
}

function injectedRenameFailure(failCalls) {
    let calls = 0;
    return async (from, to) => {
        calls += 1;
        if (failCalls.has(calls)) {
            const error = new Error(`injected migration rename failure ${calls}`);
            error.code = "EIO";
            throw error;
        }
        return rename(from, to);
    };
}

test("new migration rolls back already-moved directories when a later directory rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-rename-fail-"));
    try {
        const computers = await seedLegacyComputer(root);
        const legacyStateBefore = await readFile(join(computers, "state.json"), "utf8");
        await assert.rejects(
            () => migrateComputerRegistry(computers, AGENT_IDS, { rename: injectedRenameFailure(new Set([2])) }),
            /injected migration rename failure 2/,
        );
        await assertLegacyLayout(computers);
        assert.equal(await readFile(join(computers, "state.json"), "utf8"), legacyStateBefore);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("new migration rolls directories back when the staged v2 state commit rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-commit-fail-"));
    try {
        const computers = await seedLegacyComputer(root);
        const legacyStateBefore = await readFile(join(computers, "state.json"), "utf8");
        await assert.rejects(
            () => migrateComputerRegistry(computers, AGENT_IDS, { rename: injectedRenameFailure(new Set([3])) }),
            /injected migration rename failure 3/,
        );
        await assertLegacyLayout(computers);
        assert.equal(await readFile(join(computers, "state.json"), "utf8"), legacyStateBefore);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("rollback failure preserves migration evidence and restart rolls the transaction forward", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-rollback-fail-"));
    try {
        const computers = await seedLegacyComputer(root);
        let failure;
        try {
            await migrateComputerRegistry(computers, AGENT_IDS, { rename: injectedRenameFailure(new Set([2, 3])) });
        }
        catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof AggregateError);
        assert.match(failure.message, /migration failed and rollback also failed/);
        assert.equal(await pathExists(join(computers, "migration.json")), true);
        assert.ok((await migrationArtifacts(computers)).some((name) => name.startsWith("state.json.migration-")));
        assert.equal(await pathExists(join(computers, computerIdentityKey(AGENT_IDS[0]))), true);
        assert.equal(await pathExists(join(computers, computerLegacySegment(AGENT_IDS[1]))), true);

        const result = await migrateComputerRegistry(computers, AGENT_IDS);
        assert.equal(result.migrated, true);
        assert.equal(result.recovered, true);
        assert.deepEqual(await migrationArtifacts(computers), []);
        for (const agentId of AGENT_IDS)
            assert.equal(await pathExists(join(computers, computerIdentityKey(agentId))), true);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("stage creation failure removes the fresh marker when no migration progress was made", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-stage-fail-"));
    try {
        const computers = await seedLegacyComputer(root);
        let writes = 0;
        const writeFile = async (...args) => {
            writes += 1;
            if (writes === 2) {
                const error = new Error("injected migration stage write failure");
                error.code = "EIO";
                throw error;
            }
            return (await import("node:fs/promises")).writeFile(...args);
        };
        await assert.rejects(
            () => migrateComputerRegistry(computers, AGENT_IDS, { writeFile }),
            /injected migration stage write failure/,
        );
        await assertLegacyLayout(computers);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("marker cleanup failure leaves committed v2 state recoverable instead of rolling it backward", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-migration-marker-cleanup-"));
    try {
        const computers = await seedLegacyComputer(root);
        let failed = false;
        const unlink = async (path) => {
            if (!failed && basename(path) === "migration.json") {
                failed = true;
                const error = new Error("injected migration marker cleanup failure");
                error.code = "EIO";
                throw error;
            }
            return (await import("node:fs/promises")).unlink(path);
        };
        await assert.rejects(
            () => migrateComputerRegistry(computers, AGENT_IDS, { unlink }),
            /injected migration marker cleanup failure/,
        );
        assert.equal(JSON.parse(await readFile(join(computers, "state.json"), "utf8")).version, 2);
        assert.equal(await pathExists(join(computers, "migration.json")), true);
        for (const agentId of AGENT_IDS)
            assert.equal(await pathExists(join(computers, computerIdentityKey(agentId))), true);

        const recovered = await migrateComputerRegistry(computers, AGENT_IDS);
        assert.equal(recovered.recovered, true);
        assert.deepEqual(await migrationArtifacts(computers), []);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ComputerRegistry never creates new credentials when migration state commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-computer-registry-before-token-"));
    try {
        const dataDir = join(root, "data");
        const computers = await seedLegacyComputer(dataDir, { agentIds: [AGENT_IDS[0]] });
        const registry = new ComputerRegistry(dataDir, [AGENT_IDS[0]], {
            migrationIo: { rename: injectedRenameFailure(new Set([2])) },
        });
        await assert.rejects(() => registry.init(), /injected migration rename failure 2/);
        assert.equal(await pathExists(join(computers, "operator-token")), false);
        assert.equal(await pathExists(join(computers, computerLegacySegment(AGENT_IDS[0]), "token")), true);
        assert.equal((await readFile(join(computers, computerLegacySegment(AGENT_IDS[0]), "token"), "utf8")).trim(), LEGACY_TOKEN_A);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
