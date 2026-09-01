import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    REMOTE_CONTROLLER_NAVIGATION,
    REMOTE_CONTROLLER_PERSISTENCE_SCHEMA,
    clearRemoteControllerPersistence,
    validateAttentionDecisionInput,
    validateComputerViewInput,
    validateRemoteControllerPersistence,
} from "../src/remote-controller-contract.js";

test("remote controller contract is narrow, opaque, and cache-clearing", () => {
    assert.deepEqual([...REMOTE_CONTROLLER_NAVIGATION], ["team", "activity", "attention", "artifacts", "routines", "computer"]);
    assert.deepEqual(validateAttentionDecisionInput({ jobId: "job_0000000000000001" }), { jobId: "job_0000000000000001" });
    assert.deepEqual(validateComputerViewInput({ projectId: "project_0000000000000001", coworkerId: "coworker_0000000000000001" }), { projectId: "project_0000000000000001", coworkerId: "coworker_0000000000000001" });
    assert.throws(() => validateComputerViewInput({ projectId: "project_0000000000000001", coworkerId: "coworker_0000000000000001", path: "C:\\private" }), /unsupported/);
    const persisted = validateRemoteControllerPersistence({ schema: REMOTE_CONTROLLER_PERSISTENCE_SCHEMA, controllerId: "controller_0000000000000001", deviceId: "device_0000000000000001", displayName: "Android", transport: "trusted", preferredView: "team", lastTeamId: "team_0000000000000001" });
    assert.equal(persisted.deviceId, "device_0000000000000001");
    assert.throws(() => validateRemoteControllerPersistence({ ...persisted, signingPrivateKey: "secret" }), /unsupported/);
    const removed = [];
    clearRemoteControllerPersistence({ removeItem: (key) => removed.push(key) }, "sovereignbot.remote-controller.public.v1");
    assert.deepEqual(removed, ["sovereignbot.remote-controller.public.v1"]);
});

test("controller WebView/PWA entry is offline-first and has no direct network authority", () => {
    const html = readFileSync(new URL("../ui/controller.html", import.meta.url), "utf8");
    const app = readFileSync(new URL("../ui/controller-app.js", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../ui/controller-sw.js", import.meta.url), "utf8");
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /Pairing and transport are provided by the trusted WebView\/native host/);
    assert.match(app, /sovereignbotRemoteBridge/);
    assert.doesNotMatch(app, /fetch\s*\(|new\s+WebSocket|ipcRenderer|child_process|\.invoke\s*\(/);
    assert.doesNotMatch(worker, /fetch\s*\(/);
    for (const label of ["Team", "Activity", "Attention", "Artifacts", "Routines", "Computer"]) assert.match(app, new RegExp(label));
});
