import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { coworkerAgentId, coworkerCapability } from "./provider-roster.js";

const DISPATCH_SCHEMA = "sovereignbot.desktop.coworker-dispatch.v1";
const MAX_CONTEXT_MESSAGES = 32;
const MAX_CONTEXT_TEXT = 4_000;
const MAX_REPLY_TEXT = 20_000;
const MAX_SESSION_ID = 2_000;

function stateKey(conversationId, coworkerId) {
    return `${conversationId}:${coworkerId}`;
}

function safeSessionState(value, expectedKind) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    if (value.kind !== expectedKind)
        return undefined;
    if (typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > MAX_SESSION_ID)
        return undefined;
    return { kind: value.kind, sessionId: value.sessionId };
}

function providerKindForHarness(harnessKind) {
    return harnessKind === "codex" ? "codex" : harnessKind === "claude-code" ? "claude-code" : undefined;
}

function publicConversationContext(conversation, coworkerId) {
    return conversation.messages.slice(-MAX_CONTEXT_MESSAGES).map((message) => ({
        sender: message.senderId === "user" ? "user" : message.senderId === coworkerId ? "self" : message.senderId,
        text: String(message.text ?? "").slice(0, MAX_CONTEXT_TEXT),
        createdAt: message.createdAt,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(Array.isArray(message.artifactIds) && message.artifactIds.length ? { artifactIds: message.artifactIds.slice(0, 12) } : {}),
    }));
}

export function createCoworkerDispatcher({
    dataDir,
    runtime,
    roster,
    coworkerStore,
    conversationStore,
    services,
    persistPath = join(dataDir, "desktop-state", "coworker-dispatch.json"),
    now = () => new Date().toISOString(),
} = {}) {
    if (!dataDir || !runtime?.orchestrator || typeof roster !== "function")
        throw new Error("coworker dispatcher requires dataDir, runtime and roster reader");
    if (!coworkerStore?.get || !conversationStore?.get || !services?.workspacePath)
        throw new Error("coworker dispatcher requires coworker, conversation and workspace services");

    const persisted = loadJsonState(persistPath, null);
    const state = persisted?.schema === DISPATCH_SCHEMA && persisted.turns && typeof persisted.turns === "object"
        ? { schema: DISPATCH_SCHEMA, turns: { ...persisted.turns } }
        : { schema: DISPATCH_SCHEMA, turns: {} };
    const chains = new Map();

    function save() {
        saveJsonState(persistPath, state);
    }

    function requireBinding(coworkerId) {
        const snapshot = roster();
        const binding = snapshot?.coworkerBindings?.[coworkerId];
        if (!binding?.ready || !binding.agentId)
            throw new Error(binding?.reason ?? `coworker ${coworkerId} has no ready provider binding`);
        const expected = coworkerAgentId(coworkerId);
        if (binding.agentId !== expected)
            throw new Error(`coworker binding mismatch for ${coworkerId}`);
        return { snapshot, binding };
    }

    function workspaceContext(coworker) {
        const configured = coworker.workspaceIds ?? [];
        if (configured.length) {
            for (const workspaceId of configured) {
                const path = services.workspacePath(workspaceId);
                if (path)
                    return { workspaceId, cwd: path };
            }
            throw new Error(`${coworker.name} has configured workspaces, but none are currently available`);
        }
        // A coworker with no project workspace gets a private Desktop-owned scratch folder,
        // so ordinary conversation does not force the user to pick a repository first.
        const cwd = join(dataDir, "coworker-workspaces", coworker.id);
        mkdirSync(cwd, { recursive: true });
        return { workspaceId: `coworker:${coworker.id}`, cwd };
    }

    async function bindContinuation(task, previousTaskId, agentId, harnessKind) {
        if (!previousTaskId)
            return task;
        const previous = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === previousTaskId);
        if (!previous || previous.assignedAgentId !== agentId)
            return task;
        const expectedKind = providerKindForHarness(harnessKind);
        const continuity = safeSessionState(previous.harnessState, expectedKind);
        if (!continuity)
            return task;
        // `patch` is an internal Orchestrator primitive; no HTTP/IPC surface exposes it.
        // We validate both agent identity and provider kind before copying continuity, and
        // audit only the fact of resumption — never the provider session id itself.
        runtime.orchestrator.requireAgent(agentId);
        const updated = await runtime.orchestrator.patch(task, {
            harnessState: continuity,
            assignedAgentId: agentId,
        });
        await runtime.audit.append({
            type: "coworker.continuity_bound",
            actor: agentId,
            subject: task.id,
            data: { coworkerAgentId: agentId, resumed: true, providerKind: continuity.kind },
        });
        return updated;
    }

    async function executeDelivery(conversationId, messageId, coworkerId) {
        const coworker = coworkerStore.get(coworkerId);
        if (coworker.state !== "active")
            throw new Error(`${coworker.name} is not active`);
        const conversation = conversationStore.get(conversationId);
        const source = conversation.messages.find((entry) => entry.id === messageId);
        if (!source)
            throw new Error(`message ${messageId} does not exist in conversation ${conversationId}`);
        if (source.delivery?.[coworkerId]?.status !== "pending")
            return { skipped: true, reason: "delivery-not-pending" };

        const { snapshot, binding } = requireBinding(coworkerId);
        const context = workspaceContext(coworker);
        const supervisorAgentId = snapshot.roles?.planner;
        if (!supervisorAgentId)
            throw new Error("coworker dispatch requires a ready supervisor/planner identity");

        const plan = await runtime.orchestrator.createPlan({
            title: `${coworker.name}: conversation turn`,
            ownerAgentId: supervisorAgentId,
            input: { conversationId, coworkerId },
        });
        const turn = state.turns[stateKey(conversationId, coworkerId)] ?? {};
        let task = await runtime.orchestrator.delegateTrusted(plan.id, {
            title: `Respond as ${coworker.name}`,
            requiredCapabilities: [coworkerCapability(coworkerId)],
            preferredAgentId: binding.agentId,
            input: {
                instruction: [
                    `You are ${coworker.name}.`,
                    `Role: ${coworker.role}`,
                    coworker.instructions ? `Working instructions: ${coworker.instructions}` : "",
                    "Respond to the newest message as this persistent coworker. Preserve continuity with the conversation, be action-oriented, and do not claim work you did not actually complete.",
                ].filter(Boolean).join("\n"),
                conversation: publicConversationContext(conversation, coworkerId),
                newestMessageId: source.id,
            },
        }, context, supervisorAgentId);

        task = await bindContinuation(task, turn.lastTaskId, binding.agentId, binding.harnessKind);
        await runtime.orchestrator.runUntilIdle();
        const finished = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === task.id);
        if (finished?.status !== "completed") {
            const detail = String(finished?.error ?? `coworker turn ended as ${finished?.status ?? "unknown"}`).slice(0, 500);
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", detail);
            state.turns[stateKey(conversationId, coworkerId)] = {
                lastTaskId: task.id,
                provider: binding.provider,
                updatedAt: now(),
            };
            save();
            return { ok: false, taskId: task.id, error: detail };
        }

        const text = typeof finished.result?.text === "string" ? finished.result.text.trim().slice(0, MAX_REPLY_TEXT) : "";
        if (!text) {
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "provider returned no text reply");
            return { ok: false, taskId: task.id, error: "provider returned no text reply" };
        }

        const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, {
            text,
            replyTo: source.id,
        });
        conversationStore.markDelivery(conversationId, messageId, coworkerId, "delivered");
        state.turns[stateKey(conversationId, coworkerId)] = {
            lastTaskId: task.id,
            provider: binding.provider,
            updatedAt: now(),
        };
        save();
        return { ok: true, taskId: task.id, reply };
    }

    function scheduleDelivery(conversationId, messageId, coworkerId) {
        const key = stateKey(conversationId, coworkerId);
        const previous = chains.get(key) ?? Promise.resolve();
        const run = previous.then(() => executeDelivery(conversationId, messageId, coworkerId));
        chains.set(key, run.catch(() => {}));
        run.finally(() => {
            if (chains.get(key) === run)
                chains.delete(key);
        }).catch(() => {});
        return run;
    }

    return {
        dispatchMessage(conversationId, messageId) {
            const conversation = conversationStore.get(conversationId);
            const message = conversation.messages.find((entry) => entry.id === messageId);
            if (!message)
                throw new Error(`unknown message id: ${messageId}`);
            const recipients = Object.entries(message.delivery ?? {})
                .filter(([, delivery]) => delivery?.status === "pending")
                .map(([coworkerId]) => coworkerId);
            return recipients.map((coworkerId) => scheduleDelivery(conversationId, messageId, coworkerId));
        },

        async flush() {
            await Promise.allSettled([...chains.values()]);
        },

        stateSnapshot() {
            return structuredClone(state);
        },
    };
}
