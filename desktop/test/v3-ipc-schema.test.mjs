import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "../src/main/lib/v3-ipc-schema.js";

test("V3 coworker and conversation channels are enumerated and wired into the main IPC binder", () => {
    const expected = [
        "coworker:list", "coworker:get", "coworker:create", "coworker:update", "coworker:archive", "coworker:restore",
        "conversation:list", "conversation:get", "conversation:createDirect", "conversation:createTeam", "conversation:send",
        "team:list", "team:get", "team:installPack", "team:exportPack", "team:importPack", "team:importPackViaDialog", "team:exportPackViaDialog", "team:exportPlaybook", "team:importPlaybook", "team:createChannelFromTemplate", "team:requestParallel", "channel:list", "channel:get", "channel:create", "channel:update", "channel:archive", "channel:restore",
        "connectedApps:list", "connectedApps:search", "connectedApps:review", "connectedApps:assign", "connectedApps:connect", "connectedApps:disconnect", "connectedApps:disable", "connectedApps:health",
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
    assert.match(ipcSource, /team:activity/);
    const preloadSource = readFileSync(fileURLToPath(new URL("../src/main/preload.cjs", import.meta.url)), "utf8");
    assert.match(preloadSource, /activity: invoke\("team:activity"\)/);
    assert.match(preloadSource, /review: invoke\("connectedApps:review"\)/);
    assert.match(preloadSource, /disable: invoke\("connectedApps:disable"\)/);
});

test("parallel Team requests accept only bounded specialist tasks and a separate reviewer", () => {
    const payload = {
        conversationId: "conversation_1234567890abcdef",
        children: [
            { targetCoworkerId: "coworker_1111111111111111", boundedTask: "Inspect the bounded failure." },
            { targetCoworkerId: "coworker_2222222222222222", boundedTask: "Implement the bounded change.", requiresComputer: true },
        ],
        reviewerCoworkerId: "coworker_3333333333333333",
        reason: "These tasks are independent and need one required review.",
    };
    assert.deepEqual(validateV3IpcRequest("team:requestParallel", payload), payload);
    assert.throws(() => validateV3IpcRequest("team:requestParallel", { ...payload, children: payload.children.slice(0, 1) }), /2 to 4/);
    assert.throws(() => validateV3IpcRequest("team:requestParallel", { ...payload, ownerId: "coworker_1111111111111111" }), /unexpected request field: ownerId/);
    assert.throws(() => validateV3IpcRequest("team:requestParallel", { ...payload, children: [{ ...payload.children[0], capability: "computer" }, payload.children[1]] }), /not accepted from the renderer/);
    assert.throws(() => validateV3IpcRequest("team:requestParallel", { ...payload, children: payload.children.map((entry) => ({ ...entry, boundedTask: "" })) }), /boundedTask is required/);
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

test("team pack transfer is declarative and rejects provider/account or workspace state", () => {
    const pack = {
        schema: "sovereignbot.desktop.team-pack.v1",
        id: "demo-pack",
        name: "Demo Team",
        description: "A bounded demo team.",
        coworkers: [
            { key: "chief", name: "Chief", role: "Coordinate", instructions: "Coordinate the work.", modelBinding: { profile: "automatic" } },
            { key: "reviewer", name: "Reviewer", role: "Review", instructions: "Review the result.", modelBinding: { profile: "efficient", provider: "codex", model: "luna" } },
        ],
        channels: [{ key: "project", name: "Project Channel", kind: "project", instructions: "A bounded project room.", playbookId: "delivery" }],
        playbooks: [{ id: "delivery", name: "Delivery", description: "Coordinate and review.", steps: ["chief", "reviewer"] }],
    };
    assert.deepEqual(validateV3IpcRequest("team:importPack", { pack }), { pack });
    assert.deepEqual(validateV3IpcRequest("team:exportPack", { teamId: "team_1111111111111111" }), { teamId: "team_1111111111111111" });
    assert.deepEqual(validateV3IpcRequest("team:importPackViaDialog", {}), {});
    assert.deepEqual(validateV3IpcRequest("team:exportPackViaDialog", { teamId: "team_1111111111111111" }), { teamId: "team_1111111111111111" });
    assert.deepEqual(validateV3IpcRequest("team:exportPackViaDialog", { packId: "demo-pack" }), { packId: "demo-pack" });
    assert.throws(() => validateV3IpcRequest("team:exportPackViaDialog", {}), /exactly one/);
    assert.throws(() => validateV3IpcRequest("team:exportPackViaDialog", { teamId: "team_1111111111111111", packId: "demo-pack" }), /exactly one/);
    assert.throws(
        () => validateV3IpcRequest("team:importPack", { pack: { ...pack, coworkers: pack.coworkers.map((entry, index) => index ? entry : { ...entry, modelBinding: { ...entry.modelBinding, providerAccountId: "account" } }) } }),
        /unexpected request field: providerAccountId/,
    );
    assert.throws(
        () => validateV3IpcRequest("team:importPack", { pack: { ...pack, workspacePath: "E:/private" } }),
        /unexpected request field: workspacePath/,
    );
});

test("Antigravity account switching accepts only safe A/B/C slots and never renderer account IDs", () => {
    assert.deepEqual(validateV3IpcRequest("provider:setCoworkerAccount", { coworkerId: "coworker_aaaaaaaaaaaaaaaa", provider: "antigravity", accountSlot: "B" }), {
        coworkerId: "coworker_aaaaaaaaaaaaaaaa", provider: "antigravity", accountSlot: "B",
    });
    assert.throws(() => validateV3IpcRequest("provider:setCoworkerAccount", { coworkerId: "coworker_aaaaaaaaaaaaaaaa", provider: "antigravity", accountSlot: "account-b" }), /A, B, or C/);
    assert.throws(() => validateV3IpcRequest("coworker:update", { coworkerId: "coworker_aaaaaaaaaaaaaaaa", patch: { modelBinding: { profile: "automatic", provider: "antigravity", providerAccountId: "account-b" } } }), /unexpected request field: providerAccountId/);
});

test("playbook transfer is declarative and rejects runtime state", () => {
    const playbook = {
        schema: "sovereignbot.desktop.playbook.v1",
        id: "delivery",
        name: "Delivery",
        description: "A bounded delivery method.",
        steps: ["chief", "coding-lead", "reviewer", "chief"],
        stages: [{ id: "prepare", name: "Prepare", instructions: "Prepare the bounded change.", expectedOutput: "Draft", recommendedCoworkerRole: "Author", recommendedSkillIds: ["skill_writing"] }],
        reviewPoints: [{ id: "review", name: "Review", instructions: "Current owner reviews the draft.", recommendedCoworkerRole: "Reviewer" }],
        expectedOutput: "Approved delivery",
        recommendedCoworkerRoles: ["Author", "Reviewer"],
        recommendedSkillIds: ["skill_writing"],
    };
    assert.deepEqual(
        validateV3IpcRequest("team:importPlaybook", { teamId: "team_1111111111111111", playbook }),
        { teamId: "team_1111111111111111", playbook },
    );
    assert.deepEqual(
        validateV3IpcRequest("team:exportPlaybook", { teamId: "team_1111111111111111", playbookId: "delivery" }),
        { teamId: "team_1111111111111111", playbookId: "delivery" },
    );
    assert.throws(
        () => validateV3IpcRequest("team:importPlaybook", { teamId: "team_1111111111111111", playbook: { ...playbook, workspacePath: "E:/private" } }),
        /unexpected request field: workspacePath/,
    );
    assert.throws(
        () => validateV3IpcRequest("playbook:update", { playbookId: "delivery", patch: { stages: [{ id: "prepare", name: "Prepare", instructions: "Draft", providerAccountId: "account" }] } }),
        /unexpected request field: providerAccountId/,
    );
});

test("native Playbook file channels accept only bounded dialog payloads", () => {
    assert.deepEqual(validateV3IpcRequest("playbook:importViaDialog", {}), {});
    assert.deepEqual(validateV3IpcRequest("playbook:exportViaDialog", { playbookId: "delivery" }), { playbookId: "delivery" });
    assert.throws(() => validateV3IpcRequest("playbook:importViaDialog", { path: "E:/private/delivery.json" }), /request payload must be empty/);
    assert.throws(() => validateV3IpcRequest("playbook:exportViaDialog", { playbookId: "delivery", sessionId: "secret" }), /payload\.sessionId/);
});

test("channel template creation accepts only a bounded team/template selection", () => {
    const payload = {
        teamId: "team_1111111111111111",
        templateId: "work",
    };
    assert.deepEqual(validateV3IpcRequest("team:createChannelFromTemplate", payload), payload);
    assert.throws(
        () => validateV3IpcRequest("team:createChannelFromTemplate", { ...payload, workspacePath: "E:/private" }),
        /unexpected request field: workspacePath/,
    );
});

test("channel management accepts only bounded product fields", () => {
    const create = validateV3IpcRequest("channel:create", {
        teamId: "team_1111111111111111",
        name: "Launch Room",
        kind: "work",
        instructions: "Bounded launch work.",
        workspaceId: "workspace_1111111111111111",
        playbookId: "software-delivery",
    });
    assert.deepEqual(create, {
        teamId: "team_1111111111111111",
        name: "Launch Room",
        kind: "work",
        instructions: "Bounded launch work.",
        workspaceId: "workspace_1111111111111111",
        playbookId: "software-delivery",
    });
    assert.deepEqual(validateV3IpcRequest("channel:update", {
        channelId: "channel_1111111111111111",
        patch: { name: "Launch Review", kind: "project" },
    }), {
        channelId: "channel_1111111111111111",
        patch: { name: "Launch Review", kind: "project" },
    });
    assert.throws(
        () => validateV3IpcRequest("channel:create", { teamId: "team_1111111111111111", name: "Leak", workspacePath: "E:/private" }),
        /unexpected request field: workspacePath/,
    );
    assert.throws(
        () => validateV3IpcRequest("channel:update", { channelId: "channel_1111111111111111", patch: { conversationId: "conversation_1" } }),
        /unexpected request field: conversationId/,
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
    assert.deepEqual(validateV3IpcRequest("connectedApps:assign", { ...payload, projectId: "project_1111111111111111" }), { ...payload, projectId: "project_1111111111111111" });
    assert.deepEqual(validateV3IpcRequest("connectedApps:list", { projectId: "project_1111111111111111", query: "workspace", limit: 10 }), { projectId: "project_1111111111111111", query: "workspace", limit: 10 });
    assert.deepEqual(validateV3IpcRequest("connectedApps:connect", { appId: "sovereignbot-computer", approveMetered: false }), { appId: "sovereignbot-computer", approveMetered: false });
    assert.throws(() => validateV3IpcRequest("connectedApps:list", { path: "C:/private" }), /unexpected request field/);
    assert.throws(() => validateV3IpcRequest("connectedApps:connect", { appId: "app", url: "https://example.invalid" }), /unexpected request field/);
});
