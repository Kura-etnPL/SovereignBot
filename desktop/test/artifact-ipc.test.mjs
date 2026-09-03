import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

const ARTIFACT_ID = "artifact_1234567890abcdef";

test("artifact renderer channels are enumerated, identifier-only and bounded", () => {
    for (const channel of ["artifact:list", "artifact:get", "artifact:preview", "artifact:open", "artifact:reveal", "artifact:history", "artifact:archive", "artifact:restore", "artifact:restoreAsNewVersion", "artifact:reviseViaDialog", "artifact:exportViaDialog", "artifact:hub"])
        assert.ok(V3_IPC_CHANNELS[channel], channel);
    assert.deepEqual(validateV3IpcRequest("artifact:get", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:preview", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:open", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:reveal", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:history", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:restoreAsNewVersion", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:reviseViaDialog", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:exportViaDialog", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:archive", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:restore", { artifactId: ARTIFACT_ID }), { artifactId: ARTIFACT_ID });
    assert.deepEqual(validateV3IpcRequest("artifact:hub", { visibility: "archived", limit: 25 }), { visibility: "archived", limit: 25 });
    assert.deepEqual(validateV3IpcRequest("artifact:hub", { type: "text/markdown", limit: 25 }), { type: "text/markdown", limit: 25, visibility: "active" });
    assert.throws(() => validateV3IpcRequest("artifact:hub", { type: "text/markdown", cwd: "C:/secret" }), /not accepted from the renderer/);
    assert.deepEqual(validateV3IpcRequest("artifact:list", { conversationId: "conv_1234567890abcdef", limit: 25 }), { conversationId: "conv_1234567890abcdef", limit: 25, visibility: "active" });
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
    assert.match(source, /artifact:history/);
    assert.match(source, /artifact:restoreAsNewVersion/);
    assert.match(source, /artifact:reviseViaDialog/);
    assert.match(source, /artifact:exportViaDialog/);
    assert.match(source, /artifact:archive/);
    assert.match(source, /artifact:restore/);
    assert.doesNotMatch(source, /readFile/);
    assert.doesNotMatch(source, /writeFile/);
});

test("Artifact text projection stays main-process-only and public results stay projected", () => {
    const preload = readFileSync(fileURLToPath(new URL("../src/main/preload.cjs", import.meta.url)), "utf8");
    const search = readFileSync(fileURLToPath(new URL("../src/main/search-service.js", import.meta.url)), "utf8");
    assert.match(search, /artifactStore\?\.searchRecords/);
    assert.doesNotMatch(preload, /searchRecords|artifact:searchRecords|searchText/);
    assert.match(search, /searchText: _searchText/);
    assert.match(search, /publicResult = \{ \.\.\.publicRecord/);
});
