import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const ARTIFACT_ID = "artifact_1234567890abcdef";

test("artifact renderer channels are enumerated, identifier-only and bounded", () => {
    for (const channel of ["artifact:list", "artifact:get", "artifact:preview", "artifact:open", "artifact:reveal"])
        assert.ok(V3_IPC_CHANNELS[channel], channel);
    assert.deepEqual(validateV3IpcRequest("artifact:get", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:preview", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:open", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:reveal", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:list", { conversationId: "conv_1234567890abcdef", limit: 25 }), { conversationId: "conv_1234567890abcdef", limit: 25 });
    assert.throws(() => validateV3IpcRequest("artifact:list", { limit: 501 }), /1 to 500/);
    assert.throws(() => validateV3IpcRequest("artifact:get", { artifactId: ARTIFACT_ID, path: "C:/secret" }), /unexpected request field/);
});

test("sandboxed preload exposes artifact operations without a raw file path API", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main/preload.cjs", import.meta.url)), "utf8");
    assert.match(source, /artifacts: Object\.freeze/);
    assert.match(source, /artifact:list/);
    assert.match(source, /artifact:preview/);
    assert.match(source, /artifact:open/);
    assert.match(source, /artifact:reveal/);
    assert.doesNotMatch(source, /readFile/);
    assert.doesNotMatch(source, /writeFile/);
});
