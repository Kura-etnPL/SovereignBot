export function createSkillAwareConversationStore(conversationStore, skillStore) {
    return {
        get(conversationId) {
            return skillStore.decorateConversation(conversationStore.get(conversationId));
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

export function createSkillHandlers({ skillStore, conversationStore, dispatchMessage }) {
    return {
        "skill:list": ({ includeArchived }) => skillStore.list({ includeArchived }),
        "skill:get": ({ skillId }) => skillStore.get(skillId),
        "skill:create": ({ skill }) => skillStore.create(skill),
        "skill:update": ({ skillId, patch }) => skillStore.update(skillId, patch),
        "skill:archive": ({ skillId }) => skillStore.archive(skillId),
        "skill:restore": ({ skillId }) => skillStore.restore(skillId),
        "conversation:send": ({ conversationId, text, mentions, replyTo, artifactIds, clientMessageId, skillIds = [] }) => {
            for (const skillId of skillIds)
                skillStore.requireActive(skillId);
            const message = conversationStore.postUserMessage(conversationId, { text, mentions, replyTo, artifactIds, clientMessageId });
            if (skillIds.length)
                skillStore.bindMessage(message.id, skillIds);
            const deliveries = dispatchMessage(conversationId, message.id);
            return { message, scheduledRecipients: deliveries.length, appliedSkillIds: [...skillIds] };
        },
    };
}
