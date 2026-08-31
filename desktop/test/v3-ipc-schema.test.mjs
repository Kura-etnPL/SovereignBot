import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

test("V3 coworker and conversation channels are enumerated and wired into the main IPC binder", () => {
    const expected = [
        "coworker:list", "coworker:get", "coworker:create", "coworker:update", "coworker:archive", "coworker:restore",
        "conversation:list", "conversation:get", "conversation:createDirect", "conversation:createTeam", "conversation:send",
        "team:list", "team:get", "team:installPack", "channel:list", "channel:get",
        "connectedApps:list", "connectedApps:assign",
    ];
    for (const channel of expected)
        assert.ok(V3_IPC_CHANNELS[channel], channel);

    // Do not import ipc.js under plain Node: Electron's package shim is CommonJS there.
    // Structural wiring is enough for this unit layer; packaged Electron smoke exercises
    // the actual ipcMain binder in its real environment.
    const ipcSource = readFileSync(fileURLToPath(new URL("../src/main/ipc.js", import.meta.url)), "utf8");
    assert.match(ipcSource, /V3_IPC_CHANNELS/);
    assert.match(ipcSource, /validateV3IpcRequest/);
    assert.match(ipcSource, /ALL_IPC_CHANNELS/);
});

test("coworker create/update accepts product metadata but rejects execution authority recursively", () => {
    const created = validateV3IpcRequest("coworker:create", {
        coworker: {
            name: "Coding Lead",
            role: "Own implementation",
            providerPreference: "codex",
            workspaceIds: ["workspace_project"],
        },
    });
    assert.equal(created.coworker.name, "Coding Lead");
    assert.equal(created.coworker.providerPreference, "codex");

    for (const coworker of [
        { name: "Bad", role: "Bad", command: "cmd.exe" },
        { name: "Bad", role: "Bad", nested: { cwd: "C:/" } },
        { name: "Bad", role: "Bad", sessionId: "provider-session" },
        { name: "Bad", role: "Bad", governedTools: ["computer"] },
    ]) {
        assert.throws(
            () => validateV3IpcRequest("coworker:create", { coworker }),
            /not accepted from the renderer/,
        );
    }

    assert.throws(
        () => validateV3IpcRequest("coworker:update", { coworkerId: "coworker_1234567890abcdef", patch: {} }),
        /must not be empty/,
    );
});

test("conversation send is bounded and cannot smuggle authority", () => {
    const payload = {
        conversationId: "conv_1234567890abcdef",
        text: "@Coder please inspect this.",
        mentions: ["coworker_1234567890abcdef"],
        replyTo: "msg_1234567890abcdef",
        artifactIds: ["artifact_patch_1"],
        clientMessageId: "ui-1",
    };
    assert.deepEqual(validateV3IpcRequest("conversation:send", payload), payload);

    assert.throws(
        () => validateV3IpcRequest("conversation:send", { ...payload, command: "powershell.exe" }),
        /not accepted from the renderer/,
    );
    assert.throws(
        () => validateV3IpcRequest("conversation:send", { ...payload, text: "x".repeat(12_001) }),
        /exceeds 12000/,
    );
    assert.throws(
        () => validateV3IpcRequest("conversation:send", { ...payload, mentions: new Array(9).fill("coworker_1234567890abcdef") }),
        /at most 8/,
    );
});

test("team creation requires a bounded explicit participant set", () => {
    assert.deepEqual(
        validateV3IpcRequest("conversation:createTeam", {
            title: "Product",
            coworkerIds: ["coworker_1111111111111111", "coworker_2222222222222222"],
        }),
        {
            title: "Product",
            coworkerIds: ["coworker_1111111111111111", "coworker_2222222222222222"],
        },
    );
    assert.throws(
        () => validateV3IpcRequest("conversation:createTeam", { title: "Nope", coworkerIds: ["coworker_1111111111111111"] }),
        /at least two/,
    );
});

test("connected app assignment accepts only an opaque target and no authority fields", () => {
    const payload = {
        appId: "sovereignbot-computer",
        teamId: "team_1111111111111111",
        enabled: true,
    };
    assert.deepEqual(validateV3IpcRequest("connectedApps:assign", payload), payload);
    assert.throws(
        () => validateV3IpcRequest("connectedApps:assign", { ...payload, path: "C:/private" }),
        /unexpected request field/,
    );
    assert.throws(
        () => validateV3IpcRequest("connectedApps:assign", { ...payload, coworkerId: "coworker_1111111111111111" }),
        /exactly one/,
    );
});
