import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../src/main/conversation-store.js";

const chiefId = "coworker_0000000000000001";
const workerId = "coworker_0000000000000002";

function coworkerStore() {
  const rows = new Map([
    [chiefId, { id: chiefId, name: "Chief of Staff", role: "Coordinate specialists", state: "active" }],
    [workerId, { id: workerId, name: "Coding Lead", role: "Build software", state: "active" }],
  ]);
  return { get(id) { const row = rows.get(id); if (!row) throw new Error("missing coworker"); return structuredClone(row); }, list() { return { coworkers: [...rows.values()].map(structuredClone) }; } };
}

test("chief-led team routes ordinary user messages only to the lead", () => {
  const root = mkdtempSync(join(tmpdir(), "sovereign-chief-"));
  try {
    let message = 0;
    const store = createConversationStore({
      persistPath: join(root, "conversations.json"),
      coworkerStore: coworkerStore(),
      makeConversationId: () => "conv_0000000000000001",
      makeMessageId: () => `msg_${String(++message).padStart(16, "0")}`,
      now: () => "2026-08-27T00:00:00.000Z",
    });
    const room = store.createTeam({ title: "Chief of Staff", coworkerIds: [chiefId, workerId], leadCoworkerId: chiefId });
    assert.equal(room.leadCoworkerId, chiefId);
    const first = store.postUserMessage(room.id, { text: "Ship the product." });
    assert.deepEqual(Object.keys(first.delivery), [chiefId]);

    const direct = store.postUserMessage(room.id, { text: "Coding Lead, inspect this one directly.", mentions: [workerId] });
    assert.deepEqual(Object.keys(direct.delivery), [workerId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
