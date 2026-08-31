import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactStore } from "../src/main/artifact-store.js";
import { createAttachmentAwareConversationStore } from "../src/main/attachment-integration.js";

test("user-picked text attachment is copied durably, hides source path, and reaches only model-facing context", () => {
  const root = mkdtempSync(join(tmpdir(), "sovereign-attachments-"));
  try {
    const dataDir = join(root, "data");
    const sourcePath = join(root, "private-notes.txt");
    writeFileSync(sourcePath, "attachment canary content", "utf8");
    const store = createArtifactStore({
      dataDir,
      makeArtifactId: () => "artifact_0000000000000001",
      now: () => "2026-08-27T00:00:00.000Z",
    });
    const artifact = store.ingestPickedFile({ sourcePath, conversationId: "conv_0000000000000001" });
    assert.equal(artifact.sourceKind, "user");
    assert.equal(artifact.fileName, "private-notes.txt");
    assert.equal(JSON.stringify(artifact).includes(sourcePath), false);
    assert.equal(store.managedPath(artifact.id).includes(sourcePath), false);

    const original = {
      id: "conv_0000000000000001",
      messages: [{ id: "msg_0000000000000001", senderId: "user", text: "Read this.", artifactIds: [artifact.id] }],
    };
    const conversationStore = {
      get() { return structuredClone(original); },
      markDelivery() {},
      postUserMessage(...args) { return { args }; },
      postCoworkerMessage() {},
    };
    const modelStore = createAttachmentAwareConversationStore(conversationStore, store);
    assert.deepEqual(modelStore.postUserMessage("conv_0000000000000001", { text: "send" }), {
      args: ["conv_0000000000000001", { text: "send" }],
    });
    const decorated = modelStore.get(original.id);
    assert.equal(original.messages[0].text, "Read this.");
    assert.match(decorated.messages[0].text, /attachment canary content/);
    assert.doesNotMatch(decorated.messages[0].text, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
