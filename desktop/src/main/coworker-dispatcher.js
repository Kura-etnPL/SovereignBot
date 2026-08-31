import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { artifactPromptInstruction, extractArtifactManifest } from "./lib/artifact-manifest.js";
import { extractHandoffManifest, handoffPromptInstruction } from "./lib/handoff-manifest.js";
import { coworkerAgentId, coworkerCapability } from "./provider-roster.js";

const DISPATCH_SCHEMA = "sovereignbot.desktop.coworker-dispatch.v1";
const MAX_CONTEXT_MESSAGES = 32;
const MAX_CONTEXT_TEXT = 4_000;
const MAX_REPLY_TEXT = 20_000;
const MAX_SESSION_ID = 2_000;
const MAX_HANDOFF_DEPTH = 4;

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

function redactWorkspacePath(value, workspacePath) {
    const text = String(value ?? "");
    if (!workspacePath)
        return text;
    const escaped = String(workspacePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(escaped, "gi"), "<workspace>");
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
    artifactStore,
    services,
    teamFlow,
    isConversationBlocked = () => false,
    persistPath = join(dataDir, "desktop-state", "coworker-dispatch.json"),
    now = () => new Date().toISOString(),
} = {}) {
    if (!dataDir || !runtime?.orchestrator || typeof roster !== "function")
        throw new Error("coworker dispatcher requires dataDir, runtime and roster reader");
    if (!coworkerStore?.get || !conversationStore?.get || !services?.workspacePath)
        throw new Error("coworker dispatcher requires coworker, conversation and workspace services");
    if (artifactStore !== undefined && typeof artifactStore?.ingestWorkspaceFile !== "function")
        throw new Error("coworker dispatcher artifactStore must support ingestWorkspaceFile");

    const persisted = loadJsonState(persistPath, null);
    const state = persisted?.schema === DISPATCH_SCHEMA && persisted.turns && typeof persisted.turns === "object"
        ? { schema: DISPATCH_SCHEMA, turns: { ...persisted.turns } }
        : { schema: DISPATCH_SCHEMA, turns: {} };
    const chains = new Map();
    const activeTasks = new Map();

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

    function workspaceContext(coworker, conversation) {
        const sharedWorkspaceId = teamFlow?.workspaceIdForConversation?.(conversation?.id);
        if (sharedWorkspaceId) {
            const sharedPath = services.workspacePath(sharedWorkspaceId);
            if (sharedPath)
                return { workspaceId: sharedWorkspaceId, cwd: sharedPath };
            throw new Error("team shared project workspace is unavailable");
        }
        const configured = coworker.workspaceIds ?? [];
        if (configured.length) {
            for (const workspaceId of configured) {
                const path = services.workspacePath(workspaceId);
                if (path)
                    return { workspaceId, cwd: path };
            }
            throw new Error(`${coworker.name} has configured workspaces, but none are currently available`);
        }
        const cwd = join(dataDir, "desktop-state", "coworker-workspaces", coworker.id);
        mkdirSync(cwd, { recursive: true });
        return { workspaceId: `coworker:${coworker.id}`, cwd };
    }

    function handoffDepth(conversation, source) {
        let depth = 0;
        let cursor = source;
        const seen = new Set();
        while (cursor && cursor.senderId !== "user" && cursor.replyTo && depth <= MAX_HANDOFF_DEPTH) {
            if (seen.has(cursor.id)) break;
            seen.add(cursor.id);
            depth += 1;
            cursor = conversation.messages.find((entry) => entry.id === cursor.replyTo);
        }
        return depth;
    }

    function availableHandoffCoworkers(conversation, coworkerId, source) {
        if (conversation.kind !== "team" || handoffDepth(conversation, source) >= MAX_HANDOFF_DEPTH)
            return [];
        return conversation.participants
            .filter((id) => id !== "user" && id !== coworkerId)
            .map((id) => coworkerStore.get(id))
            .filter((entry) => entry.state === "active")
            .map((entry) => ({ id: entry.id, name: entry.name, role: entry.role }));
    }

    async function bindContinuation(task, previousTaskId, agentId, harnessKind, accountNamespace, previousAccountNamespace) {
        if (!previousTaskId)
            return task;
        const previous = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === previousTaskId);
        if (!previous || previous.assignedAgentId !== agentId)
            return task;
        if (previousAccountNamespace !== accountNamespace)
            return task;
        const expectedKind = providerKindForHarness(harnessKind);
        const continuity = safeSessionState(previous.harnessState, expectedKind);
        if (!continuity)
            return task;
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

    async function ingestDeclaredArtifacts({ rawText, context, coworkerId, conversationId, sourceMessageId, taskId }) {
        const parsed = extractArtifactManifest(rawText);
        if (parsed.invalidManifest) {
            await runtime.audit.append({
                type: "coworker.artifact_manifest_rejected",
                actor: coworkerAgentId(coworkerId),
                subject: taskId,
                data: { reason: "invalid artifact manifest" },
            });
            return { text: parsed.text, artifactIds: [] };
        }
        if (!artifactStore || !parsed.declarations.length)
            return { text: parsed.text, artifactIds: [] };

        const artifactIds = [];
        for (const declaration of parsed.declarations) {
            try {
                const artifact = artifactStore.ingestWorkspaceFile({
                    workspaceId: context.workspaceId,
                    workspacePath: context.cwd,
                    relativePath: declaration.path,
                    title: declaration.title,
                    createdByCoworkerId: coworkerId,
                    conversationId,
                    sourceMessageId,
                });
                artifactIds.push(artifact.id);
                await runtime.audit.append({
                    type: "coworker.artifact_ingested",
                    actor: coworkerAgentId(coworkerId),
                    subject: artifact.id,
                    data: { taskId, conversationId, workspaceId: context.workspaceId, sha256: artifact.sha256, size: artifact.size },
                });
            }
            catch (error) {
                await runtime.audit.append({
                    type: "coworker.artifact_rejected",
                    actor: coworkerAgentId(coworkerId),
                    subject: taskId,
                    data: { path: declaration.path, reason: String(error?.message ?? error).slice(0, 300) },
                });
            }
        }
        return { text: parsed.text, artifactIds };
    }

    async function executeDelivery(conversationId, messageId, coworkerId) {
        if (isConversationBlocked(conversationId))
            return { ok: false, stopped: true, reason: "conversation is blocked for takeover or cancellation" };
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
        const context = workspaceContext(coworker, conversation);
        const supervisorAgentId = snapshot.roles?.planner;
        if (!supervisorAgentId)
            throw new Error("coworker dispatch requires a ready supervisor/planner identity");
        const availableHandoffs = availableHandoffCoworkers(conversation, coworkerId, source);

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
                    artifactStore ? artifactPromptInstruction() : "",
                    handoffPromptInstruction(availableHandoffs),
                    artifactStore && availableHandoffs.length ? "If both files and a handoff are needed, put the SOVEREIGN_ARTIFACTS line first and the SOVEREIGN_HANDOFFS line last." : "",
                ].filter(Boolean).join("\n"),
                conversation: publicConversationContext(conversation, coworkerId),
                newestMessageId: source.id,
            },
        }, context, supervisorAgentId);

        task = await bindContinuation(task, turn.lastTaskId, binding.agentId, binding.harnessKind, binding.accountNamespace, turn.accountNamespace);
        const activeKey = stateKey(conversationId, coworkerId);
        activeTasks.set(activeKey, task.id);
        if (isConversationBlocked(conversationId)) {
            await runtime.orchestrator.cancel(task.id, { reason: "conversation was blocked before provider execution", actor: "external-team-control" }).catch(() => {});
            return { ok: false, taskId: task.id, stopped: true, reason: "conversation is blocked for takeover or cancellation" };
        }
        await runtime.orchestrator.runUntilIdle();
        const finished = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === task.id);
        if (finished?.status !== "completed") {
            const detail = String(finished?.error ?? `coworker turn ended as ${finished?.status ?? "unknown"}`).slice(0, 500);
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", detail);
            state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
            save();
            return { ok: false, taskId: task.id, error: detail };
        }

        if (isConversationBlocked(conversationId)) {
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "automation stopped for takeover or cancellation");
            return { ok: false, taskId: task.id, stopped: true, reason: "conversation is blocked for takeover or cancellation" };
        }

        const rawText = typeof finished.result?.text === "string"
            ? redactWorkspacePath(finished.result.text, context.cwd).trim().slice(0, MAX_REPLY_TEXT)
            : "";
        if (!rawText) {
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "provider returned no text reply");
            return { ok: false, taskId: task.id, error: "provider returned no text reply" };
        }

        const handoffResult = extractHandoffManifest(rawText, availableHandoffs.map((entry) => entry.id));
        if (handoffResult.invalidManifest) {
            await runtime.audit.append({
                type: "coworker.handoff_manifest_rejected",
                actor: coworkerAgentId(coworkerId),
                subject: task.id,
                data: { conversationId, messageId },
            });
        }
        const artifactResult = await ingestDeclaredArtifacts({
            rawText: handoffResult.text,
            context,
            coworkerId,
            conversationId,
            sourceMessageId: source.id,
            taskId: task.id,
        });
        const visibleText = artifactResult.text || (artifactResult.artifactIds.length ? `Created ${artifactResult.artifactIds.length} artifact${artifactResult.artifactIds.length === 1 ? "" : "s"}.` : "Completed the requested work.");
        const productHandoff = teamFlow?.nextHandoff?.({
            conversation,
            coworkerId,
            source,
            requestedCoworkerIds: handoffResult.coworkerIds,
            replyText: artifactResult.text,
        });
        // A Team Pack may own a bounded playbook sequence.  Its next stage is a
        // product routing decision, not authority supplied by model output; explicit
        // manifests remain available for ordinary user-created teams.
        const managedTeam = conversation.kind === "team" && teamFlow?.isManagedConversation?.(conversation.id);
        const nextCoworkerIds = productHandoff
            ? [productHandoff]
            : managedTeam
                ? []
                : handoffResult.coworkerIds.slice(0, 1);
        const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, {
            text: visibleText.slice(0, MAX_REPLY_TEXT),
            replyTo: source.id,
            ...(nextCoworkerIds.length ? { mentions: nextCoworkerIds } : {}),
            ...(artifactResult.artifactIds.length ? { artifactIds: artifactResult.artifactIds } : {}),
        });
        conversationStore.markDelivery(conversationId, messageId, coworkerId, "delivered");
        state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
        save();

        if (nextCoworkerIds.length) {
            await runtime.audit.append({
                type: "coworker.handoff",
                actor: coworkerAgentId(coworkerId),
                subject: reply.id,
                data: { conversationId, fromCoworkerId: coworkerId, toCoworkerIds: nextCoworkerIds, depth: handoffDepth(conversation, source) + 1 },
            });
            dispatchMessage(conversationId, reply.id);
        }
        return { ok: true, taskId: task.id, reply, artifacts: artifactResult.artifactIds, handoffs: nextCoworkerIds };
    }

    function scheduleDelivery(conversationId, messageId, coworkerId) {
        const key = stateKey(conversationId, coworkerId);
        const previous = chains.get(key) ?? Promise.resolve();
        const run = previous
            .then(() => executeDelivery(conversationId, messageId, coworkerId))
            .catch((error) => {
                const detail = String(error?.message ?? error).slice(0, 500);
                try { conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", detail); } catch {}
                return { ok: false, error: detail };
            });
        chains.set(key, run);
        run.finally(() => {
            if (chains.get(key) === run)
                chains.delete(key);
            activeTasks.delete(key);
        }).catch(() => {});
        return run;
    }

    async function stopConversation(conversationId, reason = "conversation stopped by the user", actor = "desktop-operator") {
        const prefix = `${conversationId}:`;
        const taskIds = [...activeTasks.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([, taskId]) => taskId);
        const results = await Promise.allSettled(taskIds.map((taskId) => runtime.orchestrator.cancel(taskId, {
            reason,
            actor,
        })));
        let stoppedDeliveries = 0;
        try {
            const conversation = conversationStore.get(conversationId);
            for (const message of conversation.messages ?? []) {
                for (const [coworkerId, delivery] of Object.entries(message.delivery ?? {})) {
                    if (delivery?.status !== "pending") continue;
                    conversationStore.markDelivery(conversationId, message.id, coworkerId, "failed", reason);
                    stoppedDeliveries += 1;
                }
            }
        }
        catch {
            // Cancellation must remain best-effort even if a delivery disappeared
            // concurrently; the orchestrator cancellation result is still useful.
        }
        return {
            requested: taskIds.length,
            cancelled: results.filter((entry) => entry.status === "fulfilled").length,
            stoppedDeliveries,
        };
    }

    async function cancelConversation(conversationId, reason = "conversation cancelled by external operator") {
        return stopConversation(conversationId, reason, "external-team-control");
    }

    function dispatchMessage(conversationId, messageId) {
        const conversation = conversationStore.get(conversationId);
        const message = conversation.messages.find((entry) => entry.id === messageId);
        if (!message)
            throw new Error(`unknown message id: ${messageId}`);
        if (isConversationBlocked(conversationId))
            return [];
        teamFlow?.onMessageQueued?.({ conversation, message });
        const recipients = Object.entries(message.delivery ?? {})
            .filter(([, delivery]) => delivery?.status === "pending")
            .map(([recipientId]) => recipientId);
        return recipients.map((recipientId) => scheduleDelivery(conversationId, messageId, recipientId));
    }

    return {
        dispatchMessage,
        stopConversation,
        cancelConversation,
        async flush() {
            await Promise.allSettled([...chains.values()]);
        },
        stateSnapshot() {
            return structuredClone(state);
        },
    };
}
