import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { CONVERSATIONS_SCHEMA, createConversationStore } from "../src/main/conversation-store.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-conversations-"));
    let coworkerSeq = 0;
    let conversationSeq = 0;
    let messageSeq = 0;
    let tick = 0;
    const coworkerStore = createCoworkerStore({
        persistPath: join(root, "coworkers.json"),
        now: () => `2026-08-26T00:00:${String(tick++).padStart(2, "0")}Z`,
        makeId: () => `coworker_${String(++coworkerSeq).padStart(16, "0")}`,
    });
    const chief = coworkerStore.create({ name: "Chief", role: "Coordinate work" });
    const coder = coworkerStore.create({ name: "Coder", role: "Build software" });
    const researcher = coworkerStore.create({ name: "Researcher", role: "Find evidence" });
    const conversations = createConversationStore({
        persistPath: join(root, "conversations.json"),
        coworkerStore,
        now: () => `2026-08-26T00:01:${String(tick++).padStart(2, "0")}Z`,
        makeConversationId: () => `conv_${String(++conversationSeq).padStart(16, "0")}`,
        makeMessageId: () => `msg_${String(++messageSeq).padStart(16, "0")}`,
    });
    return { root, coworkerStore, conversations, chief, coder, researcher };
}

test("direct conversations are durable, idempotent per coworker, and user messages create pending delivery", () => {
    const { root, coworkerStore, conversations, coder } = fixture();
    try {
        const direct = conversations.createDirect(coder.id);
        assert.equal(direct.kind, "direct");
        assert.equal(direct.title, "Coder");
        assert.deepEqual(direct.participants, ["user", coder.id]);
        assert.equal(conversations.createDirect(coder.id).id, direct.id);

        const message = conversations.postUserMessage(direct.id, {
            text: "Fix the login flow.",
            clientMessageId: "client-1",
        });
        assert.equal(message.senderId, "user");
        assert.equal(message.delivery[coder.id].status, "pending");

        const duplicate = conversations.postUserMessage(direct.id, {
            text: "Fix the login flow.",
            clientMessageId: "client-1",
        });
        assert.equal(duplicate.id, message.id);
        assert.equal(conversations.get(direct.id).messages.length, 1);

        const reloaded = createConversationStore({
            persistPath: join(root, "conversations.json"),
            coworkerStore,
        });
        assert.equal(reloaded.schema, CONVERSATIONS_SCHEMA);
        assert.equal(reloaded.get(direct.id).messages[0].text, "Fix the login flow.");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("team messages default to one owner, explicit mentions narrow routing, and delivery state is durable", () => {
    const { root, conversations, chief, coder, researcher } = fixture();
    try {
        const team = conversations.createTeam({
            title: "Product Team",
            coworkerIds: [chief.id, coder.id, researcher.id],
        });
        assert.equal(team.leadCoworkerId, chief.id);
        const first = conversations.postUserMessage(team.id, { text: "Ship V3." });
        assert.deepEqual(Object.keys(first.delivery), [chief.id]);

        conversations.setTeamRouteResolver(() => coder.id);
        const routed = conversations.postUserMessage(team.id, { text: "Continue the implementation." });
        assert.deepEqual(Object.keys(routed.delivery), [coder.id]);
        conversations.setTeamRouteResolver(undefined);

        const broadcast = conversations.postUserMessage(team.id, { text: "Notify the whole team.", mentions: ["everyone"] });
        assert.deepEqual(Object.keys(broadcast.delivery).sort(), [chief.id, coder.id, researcher.id].sort());

        const directed = conversations.postUserMessage(team.id, {
            text: "@Coder investigate this regression.",
            mentions: [coder.id],
            replyTo: first.id,
        });
        assert.deepEqual(Object.keys(directed.delivery), [coder.id]);
        assert.equal(directed.replyTo, first.id);

        const marked = conversations.markDelivery(team.id, directed.id, coder.id, "delivered");
        assert.equal(marked.status, "delivered");
        assert.equal(conversations.pendingFor(coder.id).some((entry) => entry.message.id === directed.id), false);
        assert.ok(conversations.pendingFor(chief.id).some((entry) => entry.message.id === broadcast.id));

        assert.throws(
            () => conversations.postUserMessage(team.id, { text: "bad mention", mentions: ["coworker_deadbeefdeadbeef"] }),
            /eligible participant/,
        );
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("coworker-to-coworker handoff is durable data, not execution authority", () => {
    const { root, conversations, chief, coder } = fixture();
    try {
        const team = conversations.createTeam({ title: "Delivery", coworkerIds: [chief.id, coder.id] });
        const handoff = conversations.postCoworkerMessage(team.id, chief.id, {
            text: "Please implement the approved fix.",
            mentions: [coder.id],
            artifactIds: ["artifact_plan_1"],
        });
        assert.equal(handoff.senderId, chief.id);
        assert.deepEqual(Object.keys(handoff.delivery), [coder.id]);
        assert.deepEqual(handoff.artifactIds, ["artifact_plan_1"]);

        for (const payload of [
            { text: "do it", command: "powershell.exe" },
            { text: "do it", cwd: "C:/Windows" },
            { text: "do it", sessionId: "provider-secret" },
            { text: "do it", nested: { token: "secret" } },
        ]) {
            assert.throws(
                () => conversations.postCoworkerMessage(team.id, chief.id, payload),
                /authority-bearing|unknown message field/,
            );
        }
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("artifact references are validated against the conversation before durable append", () => {
    const { root, conversations, chief, coder } = fixture();
    try {
        const team = conversations.createTeam({ title: "Artifact scope", coworkerIds: [chief.id, coder.id] });
        conversations.setArtifactReferenceValidator(({ conversationId, artifactIds }) => {
            if (conversationId === team.id && artifactIds.includes("artifact_wrong_channel"))
                throw new Error("artifact reference does not belong to this conversation");
        });
        assert.throws(
            () => conversations.postUserMessage(team.id, { text: "bad artifact", artifactIds: ["artifact_wrong_channel"] }),
            /does not belong to this conversation/,
        );
        assert.equal(conversations.get(team.id).messages.length, 0);
        const accepted = conversations.postUserMessage(team.id, { text: "known artifact", artifactIds: ["artifact_in_channel"] });
        assert.deepEqual(accepted.artifactIds, ["artifact_in_channel"]);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("conversation membership and threading fail closed", () => {
    const { root, coworkerStore, conversations, chief, coder, researcher } = fixture();
    try {
        assert.throws(() => conversations.createTeam({ title: "Not a team", coworkerIds: [chief.id] }), /at least two/);
        const direct = conversations.createDirect(coder.id);
        assert.throws(
            () => conversations.postCoworkerMessage(direct.id, researcher.id, { text: "intrude" }),
            /not in conversation/,
        );
        assert.throws(
            () => conversations.postUserMessage(direct.id, { text: "reply", replyTo: "msg_deadbeefdeadbeef" }),
            /existing message/,
        );

        coworkerStore.archive(coder.id);
        assert.throws(() => conversations.createTeam({ title: "Archived", coworkerIds: [chief.id, coder.id] }), /archived coworker/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
