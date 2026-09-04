/**
 * Channel Unread Producer
 * SovereignBot Desktop P18
 *
 * Listens to ConversationStore message events and produces trusted channel-unread
 * notifications for active team channels when real coworker activity occurs.
 *
 * Enforces:
 * - Fail-closed by default: only produces notification when notifyChannelUnread === true
 * - User self-message suppression (never notifies for user messages)
 * - Explicit internal intent suppression (options.internal === true)
 * - Active coworker & active team channel verification
 * - Predictable per-channel coalescing without duplicate spam
 * - Safe source projection pointing to the conversation target
 * - Redaction and opaque identity preservation
 */

export function createChannelUnreadProducer({
    notifications,
    teamService,
    coworkerStore,
    conversationStore,
}) {
    if (!notifications?.notify) throw new Error("channel unread producer requires notifications service");
    if (!teamService) throw new Error("channel unread producer requires teamService");
    if (!coworkerStore?.get) throw new Error("channel unread producer requires coworkerStore");

    function handleMessage({ conversation, message, options = {} }) {
        if (!message || !conversation) return { produced: false, reason: "invalid-payload" };

        // 1. Fail-closed default: only explicit notifyChannelUnread === true can notify
        if (options.notifyChannelUnread !== true) {
            return { produced: false, reason: "opt-out-default" };
        }

        // 2. Never notify for internal protocol turns
        if (options.internal === true || message.internal === true) {
            return { produced: false, reason: "internal-intent" };
        }

        // 3. Never notify for the user's own message
        if (message.senderId === "user") {
            return { produced: false, reason: "user-sender" };
        }

        // 4. Sender must be an active coworker
        let coworker;
        try {
            coworker = coworkerStore.get(message.senderId);
        } catch {
            return { produced: false, reason: "unknown-coworker" };
        }
        if (!coworker || coworker.state !== "active") {
            return { produced: false, reason: "inactive-or-unknown-coworker" };
        }

        // 5. Must belong to a managed active team channel
        const channel = teamService.channelForConversation?.(conversation.id);
        if (!channel || channel.archived) {
            return { produced: false, reason: "not-an-active-channel" };
        }

        // 6. Produce / coalesce channel-unread notification
        const channelName = channel.name || "Channel";
        const coworkerName = coworker.name || "Coworker";
        const title = `${channelName} · ${coworkerName}`;
        const body = message.text || "";
        const key = `channel:${channel.id}:unread`;

        const result = notifications.notify({
            category: "channel-unread",
            key,
            title,
            body,
            source: {
                target: "conversation",
                conversationId: channel.conversationId,
            },
            coalesce: true,
        });

        return {
            produced: true,
            ...result,
            channelId: channel.id,
            conversationId: channel.conversationId,
        };
    }

    // Register with conversationStore observer API if available
    let unsubscribe;
    if (typeof conversationStore?.onMessage === "function") {
        unsubscribe = conversationStore.onMessage(handleMessage);
    }

    return {
        handleMessage,
        resolveChannelUnread(conversationId) {
            return notifications.resolveChannelUnread?.(conversationId) ?? { resolved: false, count: 0 };
        },
        dispose() {
            unsubscribe?.();
        },
    };
}
