import assert from "node:assert/strict";
import test from "node:test";
import { replaceFileWithRetry } from "../src/fs-util.js";

test("atomic replace retries only transient rename errors", async () => {
    let calls = 0;
    const sleeps = [];
    await replaceFileWithRetry("source", "dest", {
        renameFn: async () => {
            calls += 1;
            if (calls < 3)
                throw Object.assign(new Error("temporarily busy"), { code: calls === 1 ? "EPERM" : "EBUSY" });
        },
        sleepFn: async (ms) => sleeps.push(ms),
    });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [8, 16]);
});

test("atomic replace does not retry permanent rename errors", async () => {
    let calls = 0;
    await assert.rejects(
        () => replaceFileWithRetry("source", "dest", {
            renameFn: async () => {
                calls += 1;
                throw Object.assign(new Error("missing source"), { code: "ENOENT" });
            },
            sleepFn: async () => { throw new Error("sleep should not run"); },
        }),
        /missing source/,
    );
    assert.equal(calls, 1);
});
