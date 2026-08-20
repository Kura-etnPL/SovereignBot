import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SidecarComputerDriver } from "../src/sidecar-computer-driver.js";

const fixture = fileURLToPath(new URL("./fixtures/env-sidecar.mjs", import.meta.url));

test("sidecar inherits only bootstrap OS environment plus explicit driver env", async () => {
    const root = await mkdtemp(join(tmpdir(), "sovereign-sidecar-env-"));
    const previous = process.env.SOVEREIGNBOT_PARENT_SECRET_TEST;
    process.env.SOVEREIGNBOT_PARENT_SECRET_TEST = "PARENT-CREDENTIAL-MUST-NOT-LEAK";
    const driver = new SidecarComputerDriver({
        agentId: "worker",
        profileDir: join(root, "profile"),
        workspaceDir: join(root, "workspace"),
    }, {
        sidecarCommand: process.execPath,
        sidecarArgs: [fixture],
        env: { EXPLICIT_SIDE_ENV: "explicit-ok" },
        startupTimeoutMs: 5000,
        requestTimeoutMs: 5000,
    });

    try {
        const health = await driver.health();
        assert.equal(health.leakedParentSecret, false);
        assert.equal(health.leakedTransportToken, false);
        assert.equal(health.explicitEnv, "explicit-ok");
    }
    finally {
        await driver.close();
        if (previous === undefined)
            delete process.env.SOVEREIGNBOT_PARENT_SECRET_TEST;
        else
            process.env.SOVEREIGNBOT_PARENT_SECRET_TEST = previous;
    }
});
