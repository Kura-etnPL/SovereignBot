export function createSkillAwareConversationStore(conversationStore, skillStore) {
    return {
        list(...args) { return conversationStore.list(...args); },
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

export function createSkillHandlers({ skillStore, conversationStore, dispatchMessage, isConversationArchived }) {
    return {
        "skill:list": ({ includeArchived }) => skillStore.list({ includeArchived }),
        "skill:get": ({ skillId }) => skillStore.get(skillId),
        "skill:create": ({ skill }) => skillStore.create(skill),
        "skill:update": ({ skillId, patch }) => skillStore.update(skillId, patch),
        "skill:archive": ({ skillId }) => skillStore.archive(skillId),
        "skill:restore": ({ skillId }) => skillStore.restore(skillId),
        "skill:assign": ({ skillId, targetKind, targetId, enabled }) => skillStore.assign(skillId, { targetKind, targetId, enabled }),
        "skill:export": ({ skillId }) => skillStore.exportSkill(skillId),
        "skill:import": ({ skill }) => skillStore.importSkill(skill),
        "skill:duplicate": ({ skillId }) => skillStore.duplicateSkill(skillId),
        "skill:retest": ({ skillId }) => skillStore.retestSkill(skillId),
        "conversation:send": ({ conversationId, text, mentions, replyTo, artifactIds, clientMessageId, skillIds = [] }) => {
            if (isConversationArchived?.(conversationId)) throw new Error("archived channel is read-only");
            for (const skillId of skillIds)
                skillStore.requireActive(skillId);
            const message = conversationStore.postUserMessage(conversationId, { text, mentions, replyTo, artifactIds, clientMessageId });
            const assigned = skillStore.assignedSkillIdsForCoworkers?.(Object.keys(message.delivery ?? {})) ?? [];
            const effectiveSkillIds = [...new Set([...skillIds, ...assigned])];
            if (effectiveSkillIds.length)
                skillStore.bindMessage(message.id, effectiveSkillIds);
            const deliveries = dispatchMessage(conversationId, message.id);
            return { message, scheduledRecipients: deliveries.length, appliedSkillIds: effectiveSkillIds };
        },
    };
}
