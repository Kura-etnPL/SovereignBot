import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { policyHash } from "../src/policy-version-store.js";
import { restoreStateBackup, STATE_BACKUP_FORMAT } from "../src/state-transfer.js";

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

async function write(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
}

async function writeJson(path, value) {
    await write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function bundle(root, files) {
    const manifestFiles = [];
    for (const [path, value] of Object.entries(files)) {
        const content = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
        await write(join(root, "files", ...path.split("/")), content);
        manifestFiles.push({ path, size: content.length, sha256: sha256(content), mode: 0o600 });
    }
    await writeJson(join(root, "manifest.json"), {
        format: STATE_BACKUP_FORMAT,
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        sourceVersion: "0.4.0-dev-test",
        mode: "core",
        sensitiveComputerState: false,
        offlineConsistencyRequired: true,
        files: manifestFiles,
    });
}

test("restore rejects a safe relative path that is not part of the state allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-allowlist-"));
    try {
        const backup = join(root, "backup");
        await bundle(backup, { "evil.txt": "benign-looking but unsupported\n" });
        await assert.rejects(
            () => restoreStateBackup({ dataDir: join(root, "target") }, backup),
            /unsafe path or unsupported state file/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("restore validates every immutable policy version, not only the active one", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-policy-history-"));
    try {
        const activeId = "policy_11111111-1111-4111-8111-111111111111";
        const corruptId = "policy_22222222-2222-4222-8222-222222222222";
        const policy = {
            rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }],
        };
        const hash = policyHash(policy);
        const at = new Date().toISOString();
        const backup = join(root, "backup");
        await bundle(backup, {
            "policy-versions/active.json": {
                schemaVersion: 1,
                versionId: activeId,
                hash,
                activatedAt: at,
            },
            [`policy-versions/versions/${activeId}.json`]: {
                schemaVersion: 1,
                id: activeId,
                hash,
                createdAt: at,
                policy,
            },
            [`policy-versions/versions/${corruptId}.json`]: {
                schemaVersion: 1,
                id: corruptId,
                hash,
                createdAt: at,
                policy: {
                    rules: [{ id: "changed", effect: "deny", match: { category: "harness" } }],
                },
            },
        });
        await assert.rejects(
            () => restoreStateBackup({ dataDir: join(root, "target") }, backup),
            /policy version hash mismatch/,
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
