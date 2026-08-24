import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { internalNodeExecutable } from "../src/internal-node.js";

test("internal node resolution defaults to process.execPath when no override is set", () => {
    assert.equal(internalNodeExecutable({}), process.execPath);
});

test("internal node resolution accepts an explicit existing file override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sovereign-internal-node-"));
    const fake = join(dir, "node.exe");
    await writeFile(fake, "#!/bin/sh\nexit 0\n");
    try {
        assert.equal(internalNodeExecutable({ SOVEREIGNBOT_INTERNAL_NODE: fake }), fake);
        assert.equal(internalNodeExecutable({ SOVEREIGNBOT_INTERNAL_NODE: `  ${fake}  ` }), fake);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("internal node resolution refuses empty, NUL-bearing, and missing overrides", async () => {
    assert.throws(() => internalNodeExecutable({ SOVEREIGNBOT_INTERNAL_NODE: "" }), /empty/);
    assert.throws(() => internalNodeExecutable({ SOVEREIGNBOT_INTERNAL_NODE: "   " }), /empty/);
    assert.throws(() => internalNodeExecutable({ SOVEREIGNBOT_INTERNAL_NODE: "bad\0path" }), /NUL/);
    assert.throws(
        () => internalNodeExecutable({ SOVEREIGNBOT_INTERNAL_NODE: join(tmpdir(), "sovereign-missing-node-definitely-absent.exe") }),
        /does not point at a file/,
    );
});
