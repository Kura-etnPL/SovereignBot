import assert from "node:assert/strict";
import test from "node:test";
import { channelNames } from "../src/main/ipc.js";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

test("V3 coworker and conversation channels are enumerated in the main IPC surface", () => {
    const expected = [
        "coworker:list", "coworker:get", "coworker:create", "coworker:update", "coworker:archive", "coworker:restore",
        "conversation:list", "conversation:get", "conversation:createDirect", "conversation:createTeam", "conversation:send",
    ];
    const names = channelNames();
    for (const channel of expected) {
        assert.ok(names.includes(channel), channel);
        assert.ok(V3_IPC_CHANNELS[channel], channel);
    }
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
