import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    COWORKERS_SCHEMA,
    createCoworkerStore,
    defaultCoworkerBlueprints,
} from "../src/main/coworker-store.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-coworkers-"));
    const path = join(root, "coworkers.json");
    let tick = 0;
    let id = 0;
    const store = createCoworkerStore({
        persistPath: path,
        now: () => `2026-08-26T00:00:${String(tick++).padStart(2, "0")}Z`,
        makeId: () => `coworker_${String(++id).padStart(16, "0")}`,
    });
    return { root, path, store };
}

test("coworker registry creates durable public coworker identities without execution authority", () => {
    const { root, path, store } = fixture();
    try {
        const created = store.create({
            name: "Researcher",
            role: "Investigate questions",
            instructions: "Compare evidence and report findings.",
            providerPreference: "auto",
            skillIds: ["skill_research"],
            workspaceIds: ["workspace_docs"],
        });
        assert.equal(created.id, "coworker_0000000000000001");
        assert.equal(created.state, "active");
        assert.deepEqual(created.skillIds, ["skill_research"]);
        assert.deepEqual(created.workspaceIds, ["workspace_docs"]);

        const disk = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(disk.schema, COWORKERS_SCHEMA);
        assert.equal(disk.coworkers.length, 1);
        assert.equal(disk.coworkers[0].name, "Researcher");
        assert.equal(disk.coworkers[0].providerPreference, "auto");
        for (const forbidden of ["command", "cwd", "sessionId", "token", "capabilities", "governedTools"])
            assert.equal(Object.hasOwn(disk.coworkers[0], forbidden), false, `${forbidden} must not persist on coworker identity`);

        const reloaded = createCoworkerStore({ persistPath: path });
        assert.equal(reloaded.get(created.id).name, "Researcher");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coworker registry rejects execution authority, unknown fields and invalid provider preferences", () => {
    const { root, store } = fixture();
    try {
        for (const payload of [
            { name: "Bad", role: "Bad", command: "powershell.exe" },
            { name: "Bad", role: "Bad", cwd: "C:/Windows" },
            { name: "Bad", role: "Bad", sessionId: "secret" },
            { name: "Bad", role: "Bad", capabilities: ["computer"] },
            { name: "Bad", role: "Bad", nested: { token: "secret" } },
        ]) {
            assert.throws(() => store.create(payload), /authority-bearing|unknown coworker field/);
        }
        assert.throws(
            () => store.create({ name: "Bad", role: "Bad", providerPreference: "metered-api" }),
            /providerPreference/,
        );
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coworker updates are bounded, versioned, archivable and restoreable", () => {
    const { root, store } = fixture();
    try {
        const coworker = store.create({ name: "Coding Lead", role: "Build software" });
        const updated = store.update(coworker.id, {
            name: "Principal Engineer",
            providerPreference: "codex",
            skillIds: ["skill_code", "skill_review", "skill_code"],
        });
        assert.equal(updated.name, "Principal Engineer");
        assert.equal(updated.providerPreference, "codex");
        assert.deepEqual(updated.skillIds, ["skill_code", "skill_review"]);
        assert.notEqual(updated.updatedAt, updated.createdAt);

        store.archive(coworker.id);
        assert.equal(store.list().coworkers.length, 0);
        assert.equal(store.list({ includeArchived: true }).coworkers[0].state, "archived");

        store.restore(coworker.id);
        assert.equal(store.get(coworker.id).state, "active");
        assert.throws(() => store.update(coworker.id, { command: "cmd.exe" }), /authority-bearing/);
        assert.throws(() => store.update(coworker.id, { imaginarySetting: true }), /unknown coworker field/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("default coworker blueprints seed only on an empty registry and remain ordinary editable coworkers", () => {
    const { root, store } = fixture();
    try {
        const blueprints = defaultCoworkerBlueprints();
        assert.deepEqual(blueprints.map((entry) => entry.name), ["Chief of Staff", "Coding Lead", "Researcher"]);

        const seeded = store.ensureDefaults();
        assert.equal(seeded.coworkers.length, 3);
        assert.equal(seeded.coworkers[0].name, "Chief of Staff");
        assert.equal(seeded.coworkers[1].providerPreference, "codex");

        // Idempotent: opening the product again must not duplicate built-ins.
        assert.equal(store.ensureDefaults().coworkers.length, 3);

        const changed = store.update(seeded.coworkers[0].id, { name: "My Chief" });
        assert.equal(changed.name, "My Chief");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
