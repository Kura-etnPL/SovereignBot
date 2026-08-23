import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
    COMPUTER_MIGRATION_KIND,
    COMPUTER_MIGRATION_SCHEMA_VERSION,
    computerAgentSetHash,
    computerIdentityKey,
    computerLegacySegment,
    inspectComputerMigration,
} from "../src/computer-migration.js";

export const MIGRATION_ID = "computermig_11111111-1111-4111-8111-111111111111";
export const AGENT_IDS = ["worker-a", "worker-b"];
export const LEGACY_TOKEN_A = "legacy-token-a";
export const LEGACY_TOKEN_B = "legacy-token-b";
export const PROFILE_SECRET = "legacy-profile-cookie";
export const WORKSPACE_SECRET = "legacy-workspace-data";

export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function runtimeConfig(dataDir, agentIds = AGENT_IDS) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: agentIds.map((id) => ({
            id,
            name: id,
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        })),
        policy: {
            repeatWindowMs: 180000,
            repeatMaxActiveFingerprints: 10000,
            rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
        },
    };
}

export async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function pathExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}

export async function seedLegacyComputer(dataDir, {
    agentIds = AGENT_IDS,
    withState = true,
} = {}) {
    const root = join(dataDir, "computers");
    await mkdir(root, { recursive: true });
    if (withState) {
        const legacyState = {};
        for (const [index, agentId] of agentIds.entries()) {
            legacyState[agentId] = {
                control: {
                    mode: index === 0 ? "human" : "agent",
                    actorId: index === 0 ? "operator" : undefined,
                    updatedAt: "2026-08-20T00:00:00.000Z",
                },
            };
        }
        await writeJson(join(root, "state.json"), legacyState);
    }
    for (const [index, agentId] of agentIds.entries()) {
        const legacy = join(root, computerLegacySegment(agentId));
        await mkdir(join(legacy, "profile"), { recursive: true });
        await mkdir(join(legacy, "workspace"), { recursive: true });
        await writeFile(join(legacy, "token"), `${index === 0 ? LEGACY_TOKEN_A : LEGACY_TOKEN_B}\n`, "utf8");
        await writeFile(join(legacy, "profile", "Cookies"), `${PROFILE_SECRET}-${agentId}\n`, "utf8");
        await writeFile(join(legacy, "workspace", "note.txt"), `${WORKSPACE_SECRET}-${agentId}\n`, "utf8");
    }
    return root;
}

export async function migrationPlan(root, agentIds = AGENT_IDS) {
    const inspection = await inspectComputerMigration(root, agentIds);
    if (!["needs-migration", "needs-directory-migration"].includes(inspection.status))
        throw new Error(`fixture expected migration-needed state, got ${inspection.status}`);
    const marker = {
        schemaVersion: COMPUTER_MIGRATION_SCHEMA_VERSION,
        kind: COMPUTER_MIGRATION_KIND,
        migrationId: MIGRATION_ID,
        startedAt: "2026-08-23T00:00:00.000Z",
        sourceStateMissing: inspection.sourceStateMissing === true,
        sourceStateSha256: sha256(inspection.sourceStateRaw),
        targetStateSha256: sha256(Buffer.from(inspection.targetStateText)),
        agentSetSha256: computerAgentSetHash(agentIds),
    };
    return {
        inspection,
        marker,
        markerPath: join(root, "migration.json"),
        stagePath: join(root, `state.json.migration-${MIGRATION_ID}`),
        statePath: join(root, "state.json"),
    };
}

export async function persistMarker(plan, { stage = false } = {}) {
    await writeJson(plan.markerPath, plan.marker);
    if (stage)
        await writeFile(plan.stagePath, plan.inspection.targetStateText, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function moveLegacyDirectory(root, agentId) {
    await rename(
        join(root, computerLegacySegment(agentId)),
        join(root, computerIdentityKey(agentId)),
    );
}

export async function assertMigratedComputer(root, agentIds = AGENT_IDS) {
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    if (state.version !== 2)
        throw new Error("expected v2 state");
    for (const agentId of agentIds) {
        if (await pathExists(join(root, computerLegacySegment(agentId))))
            throw new Error(`legacy directory still exists for ${agentId}`);
        if (!await pathExists(join(root, computerIdentityKey(agentId))))
            throw new Error(`current directory missing for ${agentId}`);
    }
    if (await pathExists(join(root, "migration.json")))
        throw new Error("migration marker still exists");
    const stages = (await import("node:fs/promises")).readdir(root).then((names) => names.filter((name) => name.startsWith("state.json.migration-")));
    if ((await stages).length)
        throw new Error("migration stage still exists");
    return state;
}
