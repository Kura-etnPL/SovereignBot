function decorateMessageWithAttachments(message, artifactStore) {
    if (!Array.isArray(message.artifactIds) || message.artifactIds.length === 0)
        return message;
    let attachments;
    try { attachments = artifactStore.contextForMessage(message.artifactIds); }
    catch { return message; }
    if (!attachments.length) return message;
    const block = attachments.map((entry) => {
        const head = `Attachment: ${entry.title || entry.fileName} (${entry.mimeType}, ${entry.size} bytes)`;
        if (entry.text === undefined) return head;
        return `${head}\n${entry.text}${entry.truncated ? "\n… attachment content truncated" : ""}`;
    }).join("\n\n");
    return { ...message, text: `${message.text}\n\n<user_attachments>\n${block}\n</user_attachments>` };
}

export function createAttachmentAwareConversationStore(conversationStore, artifactStore) {
    return {
        get(conversationId) {
            const conversation = structuredClone(conversationStore.get(conversationId));
            conversation.messages = conversation.messages.map((message) => decorateMessageWithAttachments(message, artifactStore));
            return conversation;
        },
        markDelivery(...args) {
            return conversationStore.markDelivery(...args);
        },
        postUserMessage(...args) {
            return conversationStore.postUserMessage(...args);
        },
        postCoworkerMessage(...args) {
            return conversationStore.postCoworkerMessage(...args);
        },
    };
}

export async function pickConversationAttachments({ win, dialog, artifactStore, conversationId }) {
    const selected = await dialog.showOpenDialog(win, {
        title: "Attach files",
        properties: ["openFile", "multiSelections"],
    });
    if (selected.canceled || !selected.filePaths?.length)
        return { canceled: true, artifacts: [] };
    const artifacts = [];
    const errors = [];
    for (const path of selected.filePaths.slice(0, 12)) {
        try {
            artifacts.push(artifactStore.ingestPickedFile({ sourcePath: path, conversationId }));
        }
        catch (error) {
            errors.push(String(error?.message ?? error).slice(0, 300));
        }
    }
    return { canceled: false, artifacts, errors };
}

export async function pickArtifactRevision({ win, dialog, artifactStore, artifactId }) {
    const selected = await dialog.showOpenDialog(win, {
        title: "Create a new artifact version",
        properties: ["openFile"],
    });
    if (selected.canceled || !selected.filePaths?.length)
        return { canceled: true, artifact: undefined };
    try {
        return { canceled: false, artifact: artifactStore.reviseFromPickedFile({ artifactId, sourcePath: selected.filePaths[0] }) };
    }
    catch (error) {
        return { canceled: false, artifact: undefined, error: String(error?.message ?? error).slice(0, 300) };
    }
}
