import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyCrashRecovery, inspectCrashRecovery } from "../src/crash-recovery.js";
import { createRuntime } from "../src/runtime.js";

const UUID = "33333333-3333-4333-8333-333333333333";

function config(dataDir) {
    return {
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{ id: "echo", name: "Echo", role: "worker", capabilities: ["demo"], harness: { kind: "echo" } }],
        policy: { rules: [{ id: "allow", effect: "allow", match: { category: "harness" } }] },
    };
}

async function initialized(root) {
    const dataDir = join(root, "data");
    const runtimeConfig = config(dataDir);
    const runtime = await createRuntime(runtimeConfig);
    await runtime.close();
    return { dataDir, runtimeConfig };
}

test("recovery refuses dataDir and quarantine symlink/junction components where the platform permits links", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-links-"));
    try {
        const target = join(root, "target");
        await mkdir(target);
        const dataLink = join(root, "data-link");
        try {
            await symlink(target, dataLink, process.platform === "win32" ? "junction" : "dir");
        }
        catch (error) {
            if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
                t.skip(`runner cannot create directory link: ${error.code}`);
                return;
            }
            throw error;
        }
        await assert.rejects(() => inspectCrashRecovery(config(dataLink)), /dataDir traverses a symbolic-link\/junction component/);

        const source = await initialized(join(root, "source"));
        await writeFile(join(source.dataDir, `tasks.json.tmp-1-${UUID}`), "stale\n", "utf8");
        const quarantineTarget = join(root, "quarantine-target");
        await mkdir(quarantineTarget);
        const quarantineLink = join(root, "quarantine-link");
        await symlink(quarantineTarget, quarantineLink, process.platform === "win32" ? "junction" : "dir");
        await assert.rejects(
            () => applyCrashRecovery(source.runtimeConfig, { quarantine: join(quarantineLink, "q") }),
            /quarantine traverses a symbolic-link\/junction component/,
        );
        assert.ok((await readdir(source.dataDir)).some((name) => name.startsWith("tasks.json.tmp-")));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("recognized recovery filename implemented as a symlink is a blocker, not a move target", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-file-link-"));
    try {
        const { dataDir, runtimeConfig } = await initialized(root);
        const external = join(root, "external.txt");
        await writeFile(external, "EXTERNAL_MUST_NOT_MOVE\n", "utf8");
        const link = join(dataDir, `tasks.json.tmp-1-${UUID}`);
        try {
            await symlink(external, link, "file");
        }
        catch (error) {
            if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
                t.skip(`runner cannot create file symlink: ${error.code}`);
                return;
            }
            throw error;
        }
        const report = await inspectCrashRecovery(runtimeConfig);
        assert.ok(report.blockingUnrecoverable.some((entry) => entry.code === "unsafe-recoverable-entry"));
        assert.equal(report.recoverable.length, 0);
        await assert.rejects(() => applyCrashRecovery(runtimeConfig), /no recognized stale artifacts|blocking unrecognized\/unsafe state/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("cleanup plus rollback failure is surfaced as an AggregateError instead of hiding partial recovery state", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-recovery-double-failure-"));
    try {
        const { dataDir, runtimeConfig } = await initialized(root);
        await writeFile(join(dataDir, `repeat-state.json.tmp-1-${UUID}`), "first\n", "utf8");
        await writeFile(join(dataDir, `tasks.json.tmp-2-${UUID}`), "second\n", "utf8");
        let calls = 0;
        const renameFn = async (from, to) => {
            calls += 1;
            if (calls === 2 || calls === 3) {
                const error = new Error(calls === 2 ? "injected cleanup failure" : "injected rollback failure");
                error.code = "EIO";
                throw error;
            }
            return rename(from, to);
        };
        let failure;
        try {
            await applyCrashRecovery(runtimeConfig, { quarantine: join(root, "quarantine"), renameFn });
        }
        catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof AggregateError);
        assert.match(failure.message, /recovery failed and artifact rollback also failed/);
        assert.ok(failure.errors.some((error) => /cleanup failure/.test(error.message)));
        assert.ok(failure.errors.some((error) => error instanceof AggregateError && /could not be rolled back/.test(error.message)));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
