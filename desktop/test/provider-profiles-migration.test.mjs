import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateProviderProfiles } from "../src/main/provider-profiles-migration.js";
import { preflightRuntimeStartup } from "../vendor/core/src/startup-preflight.js";

test("migrateProviderProfiles is a safe no-op when provider-profiles does not exist", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-migration-noop-"));
    try {
        const result = migrateProviderProfiles({ dataDir });
        assert.deepEqual(result, { migrated: false, moved: 0 });
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test("migrateProviderProfiles safely cleans up an empty legacy provider-profiles directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-migration-empty-"));
    try {
        mkdirSync(join(dataDir, "provider-profiles"), { recursive: true });
        const result = migrateProviderProfiles({ dataDir });
        assert.equal(result.migrated, true);
        assert.equal(existsSync(join(dataDir, "provider-profiles")), false);
        assert.equal(existsSync(join(dataDir, "desktop-state", "provider-profiles")), true);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test("migrateProviderProfiles migrates nested provider accounts non-destructively and cleans up top level", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-migration-live-"));
    try {
        const chatgptAccount = join(dataDir, "provider-profiles", "chatgpt-web", "provider-account-test12345");
        const antigravityAccount = join(dataDir, "provider-profiles", "antigravity", "provider-account-anti67890");
        mkdirSync(chatgptAccount, { recursive: true });
        mkdirSync(antigravityAccount, { recursive: true });

        writeFileSync(join(chatgptAccount, "session.json"), JSON.stringify({ token: "chatgpt-secret-token", loggedIn: true }));
        writeFileSync(join(antigravityAccount, "provider-state.json"), JSON.stringify({ schema: "sovereignbot.antigravity.profile.v1", ready: true }));

        const result = migrateProviderProfiles({ dataDir });
        assert.equal(result.migrated, true);
        assert.equal(result.moved > 0, true);

        // Top-level provider-profiles must be removed so core preflight passes
        assert.equal(existsSync(join(dataDir, "provider-profiles")), false);

        // Migrated files must exist with intact content
        const migratedChatGPT = join(dataDir, "desktop-state", "provider-profiles", "chatgpt-web", "provider-account-test12345", "session.json");
        const migratedAntigravity = join(dataDir, "desktop-state", "provider-profiles", "antigravity", "provider-account-anti67890", "provider-state.json");

        assert.equal(existsSync(migratedChatGPT), true);
        assert.equal(JSON.parse(readFileSync(migratedChatGPT, "utf8")).token, "chatgpt-secret-token");

        assert.equal(existsSync(migratedAntigravity), true);
        assert.equal(JSON.parse(readFileSync(migratedAntigravity, "utf8")).ready, true);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test("migrateProviderProfiles merges accounts non-destructively when target directory already exists", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-migration-merge-"));
    try {
        // Pre-existing account in desktop-state
        const existingAccount = join(dataDir, "desktop-state", "provider-profiles", "chatgpt-web", "account-existing");
        mkdirSync(existingAccount, { recursive: true });
        writeFileSync(join(existingAccount, "data.txt"), "existing-account-data");

        // Incoming account in legacy directory
        const incomingAccount = join(dataDir, "provider-profiles", "chatgpt-web", "account-incoming");
        mkdirSync(incomingAccount, { recursive: true });
        writeFileSync(join(incomingAccount, "data.txt"), "incoming-account-data");

        const result = migrateProviderProfiles({ dataDir });
        assert.equal(result.migrated, true);
        assert.equal(existsSync(join(dataDir, "provider-profiles")), false);

        // Both accounts must now coexist under desktop-state
        assert.equal(readFileSync(join(dataDir, "desktop-state", "provider-profiles", "chatgpt-web", "account-existing", "data.txt"), "utf8"), "existing-account-data");
        assert.equal(readFileSync(join(dataDir, "desktop-state", "provider-profiles", "chatgpt-web", "account-incoming", "data.txt"), "utf8"), "incoming-account-data");
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test("Core startup preflight fails on unmigrated legacy provider-profiles and succeeds after migration", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "sb-migration-preflight-"));
    try {
        // Create standard minimal valid runtime directory
        writeFileSync(join(dataDir, "tasks.json"), "[]\n");
        mkdirSync(join(dataDir, "desktop-state"), { recursive: true });

        // Add unsupported legacy provider-profiles
        const legacyAccount = join(dataDir, "provider-profiles", "chatgpt-web", "account-daily");
        mkdirSync(legacyAccount, { recursive: true });
        writeFileSync(join(legacyAccount, "auth.json"), "{}");

        // Preflight MUST fail before migration
        await assert.rejects(
            async () => preflightRuntimeStartup({ dataDir }),
            /startup preflight failed: dataDir contains unsupported state path: provider-profiles/
        );

        // Run migration
        const migrationResult = migrateProviderProfiles({ dataDir });
        assert.equal(migrationResult.migrated, true);

        // Preflight MUST now succeed without throwing
        const preflightResult = await preflightRuntimeStartup({ dataDir });
        assert.equal(preflightResult.dataDir, dataDir);
    } finally {
        rmSync(dataDir, { recursive: true, force: true });
    }
});
