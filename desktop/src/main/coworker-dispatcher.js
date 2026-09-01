import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { artifactPromptInstruction, extractArtifactManifest } from "./lib/artifact-manifest.js";
import { extractFanoutManifest, extractHandoffManifest, extractReviewDecision, fanoutPromptInstruction, handoffPromptInstruction, reviewPromptInstruction } from "./lib/handoff-manifest.js";
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

    function recordTeamEvent(payload) {
        try {
            const context = teamFlow?.collaborationContextForConversation?.(payload.conversationId);
            return teamFlow?.recordCollaborationEvent?.({
                ...payload,
                ...(context ? {
                    runId: payload.runId ?? context.runId,
                    requestId: payload.requestId ?? context.requestId,
                    operationId: payload.operationId ?? context.operationId,
                    operationToken: payload.operationToken ?? context.operationToken,
                    expectedVersion: payload.expectedVersion ?? context.version,
                } : {}),
            });
        }
        catch (error) { throw error; }
    }

    function publishGate(conversationId, messageId, coworkerId, expected) {
        const current = conversationStore.get(conversationId).messages.find((entry) => entry.id === messageId);
        if (current?.delivery?.[coworkerId]?.status !== "pending") return false;
        if (!expected || !teamFlow?.collaborationContextForConversation) return true;
        const context = teamFlow.collaborationContextForConversation(conversationId);
        if (!context || context.runId !== expected.runId || context.requestId !== expected.requestId || context.ownerId !== coworkerId || context.operationId !== expected.operationId || context.operationToken !== expected.operationToken || context.version < (expected.version ?? 0)) return false;
        if (expected.activeProtocol) {
            const protocol = context.activeProtocol;
            if (!protocol || protocol.protocolRequestId !== expected.activeProtocol.protocolRequestId || protocol.revision !== expected.activeProtocol.revision) return false;
            if (!["working", "reviewing", "submitted", "approved"].includes(protocol.state)) return false;
        }
        return true;
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

    function fanoutWorkspaceContext(conversationId, fanoutContext) {
        const proof = teamFlow.fanoutWorkspaceForChild({ conversationId, childKey: fanoutContext.child.key });
        const cwd = join(dataDir, "desktop-state", "coworker-workspaces", "fanout", fanoutContext.fanout.fanoutId, fanoutContext.child.workspaceKey);
        mkdirSync(cwd, { recursive: true });
        return { workspaceId: proof.workspaceId, cwd };
    }

    function fanoutPublishGate(conversationId, messageId, coworkerId, expected, mode) {
        const current = conversationStore.get(conversationId).messages.find((entry) => entry.id === messageId);
        if (current?.delivery?.[coworkerId]?.status !== "pending") return false;
        const context = teamFlow?.fanoutContextForConversation?.(conversationId);
        const fanout = context?.activeFanout;
        if (!context || !fanout || fanout.fanoutId !== expected?.fanoutId || context.runId !== expected.runId) return false;
        if (mode === "child") {
            const child = fanout.children.find((entry) => entry.key === expected.childKey && entry.coworkerId === coworkerId);
            return Boolean(child && child.taskId === expected.taskId && child.state === "running");
        }
        if (mode === "review") return fanout.reviewerCoworkerId === coworkerId && ["review_requested", "reviewing"].includes(fanout.state);
        return fanout.ownerCoworkerId === coworkerId && ["join_requested", "joining"].includes(fanout.state);
    }

    function fanoutPrompt(fanoutMode, fanoutContext, conversationId) {
        if (fanoutMode === "child")
            return `This is independent fan-out child ${fanoutContext.child.key}. Execute only this bounded task: ${fanoutContext.child.task}. Use only your isolated private work root, do not hand off, and return the result without claiming completion of other children.`;
        if (fanoutMode === "review") {
            const summary = teamFlow.fanoutJoinSummary(conversationId);
            return `This is the required independent review of parallel specialist results. Review the bounded child reports below and append the required review decision. Results: ${JSON.stringify(summary?.children ?? [])}`;
        }
        if (fanoutMode === "join") {
            const summary = teamFlow.fanoutJoinSummary(conversationId);
            return `This is the original owner's join step. Synthesize only after all independent children completed and the reviewer approved. Child reports: ${JSON.stringify(summary?.children ?? [])}. Publish a concise final result for the user.`;
        }
        return "";
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

    async function ingestDeclaredArtifacts({ rawText, context, coworkerId, conversationId, sourceMessageId, taskId, protocolContext }) {
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
                    published: false,
                    ...(protocolContext?.activeProtocol ? { protocolLineage: {
                        runId: protocolContext.runId,
                        requestId: protocolContext.requestId,
                        operationId: protocolContext.operationId,
                        protocolRequestId: protocolContext.activeProtocol.protocolRequestId,
                        revision: protocolContext.activeProtocol.revision,
                    } } : {}),
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

    function discardArtifacts(ids) {
        if (!ids?.length || !artifactStore?.discardArtifacts) return;
        try { artifactStore.discardArtifacts(ids); } catch {}
    }

    function closeInternalReply(conversationId, reply) {
        for (const [recipientId, delivery] of Object.entries(reply?.delivery ?? {})) {
            if (delivery?.status === "pending") {
                try { conversationStore.markDelivery(conversationId, reply.id, recipientId, "delivered"); } catch {}
            }
        }
    }

    async function executeDelivery(conversationId, messageId, coworkerId) {
        if (isConversationBlocked(conversationId))
            return { ok: false, stopped: true, reason: "conversation is blocked for takeover or cancellation" };
        const coworker = coworkerStore.get(coworkerId);
        const conversation = conversationStore.get(conversationId);
        const source = conversation.messages.find((entry) => entry.id === messageId);
        if (!source)
            throw new Error(`message ${messageId} does not exist in conversation ${conversationId}`);
        if (source.delivery?.[coworkerId]?.status !== "pending")
            return { skipped: true, reason: "delivery-not-pending" };

        let stageContext = teamFlow?.collaborationContextForConversation?.(conversationId);
        const fanoutChild = teamFlow?.fanoutChildForDelivery?.({ conversationId, messageId, coworkerId });
        const fanoutReview = teamFlow?.fanoutReviewForDelivery?.({ conversationId, messageId, coworkerId });
        const fanoutJoin = teamFlow?.fanoutJoinForDelivery?.({ conversationId, messageId, coworkerId });
        const fanoutContext = fanoutChild ?? fanoutReview ?? fanoutJoin;
        const fanoutMode = fanoutChild ? "child" : fanoutReview ? "review" : fanoutJoin ? "join" : undefined;
        const pendingProtocol = ["requested", "review_requested"].includes(stageContext?.activeProtocol?.state)
            ? stageContext.activeProtocol
            : undefined;
        const blockPendingProtocol = async (reason) => {
            if (!pendingProtocol || !teamFlow?.recordCollaborationEvent) return;
            try {
                recordTeamEvent({
                    conversationId,
                    type: "handoff.blocked",
                    status: "attention",
                    actorId: stageContext.ownerId ?? coworkerId,
                    ownerId: stageContext.ownerId ?? coworkerId,
                    targetCoworkerId: pendingProtocol.targetCoworkerId,
                    messageId: source.id,
                    reason,
                    ...stageContext,
                    expectedVersion: stageContext.version,
                    idempotencyKey: "protocol.blocked:" + pendingProtocol.protocolRequestId,
                });
            } catch {}
        };
        const blockPendingFanout = async (reason) => {
            if (!fanoutMode || !teamFlow?.blockFanout) return;
            try {
                teamFlow.blockFanout({ conversationId, reason, coworkerId, childKey: fanoutContext.child?.key, taskId: activeTasks.get(stateKey(conversationId, coworkerId)) });
            } catch {}
        };
        if (coworker.state !== "active") {
            if (pendingProtocol) {
                await blockPendingProtocol("The designated coworker is not active.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The designated coworker is not active.");
                return { ok: false, attention: true, reason: "The designated coworker is not active." };
            }
            throw new Error(`${coworker.name} is not active`);
        }
        let snapshot;
        let binding;
        let context;
        try {
            ({ snapshot, binding } = requireBinding(coworkerId));
            context = fanoutChild ? fanoutWorkspaceContext(conversationId, fanoutChild) : workspaceContext(coworker, conversation);
        }
        catch (error) {
            if (!pendingProtocol) throw error;
            await blockPendingProtocol("The designated coworker is not ready for this protocol.");
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The designated coworker is not ready for this protocol.");
            return { ok: false, attention: true, reason: "The designated coworker is not ready for this protocol." };
        }
        const supervisorAgentId = snapshot.roles?.planner;
        if (!supervisorAgentId) {
            if (pendingProtocol) {
                await blockPendingProtocol("The team supervisor is not ready for this protocol.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The team supervisor is not ready for this protocol.");
                return { ok: false, attention: true, reason: "The team supervisor is not ready for this protocol." };
            }
            throw new Error("coworker dispatch requires a ready supervisor/planner identity");
        }
        const availableHandoffs = fanoutMode ? [] : availableHandoffCoworkers(conversation, coworkerId, source);

        const plan = await runtime.orchestrator.createPlan({
            title: `${coworker.name}: conversation turn`,
            ownerAgentId: supervisorAgentId,
            input: { conversationId, coworkerId },
        });
        const turn = state.turns[stateKey(conversationId, coworkerId)] ?? {};
        const stableFanoutTask = fanoutMode && typeof runtime.orchestrator.listTasks === "function"
            ? (await runtime.orchestrator.listTasks()).find((entry) => entry.input?.fanoutId === fanoutContext.fanout.fanoutId && entry.input?.fanoutMode === fanoutMode && entry.input?.fanoutChildKey === fanoutContext.child?.key && entry.input?.messageId === source.id && !["failed", "cancelled"].includes(entry.status))
            : undefined;
        let task = stableFanoutTask ?? await runtime.orchestrator.delegateTrusted(plan.id, {
            title: fanoutMode ? `${fanoutMode} for ${coworker.name}` : `Respond as ${coworker.name}`,
            requiredCapabilities: [coworkerCapability(coworkerId)],
            preferredAgentId: binding.agentId,
            dependencyIds: [],
            input: {
                ...(fanoutMode ? {
                    fanoutId: fanoutContext.fanout.fanoutId,
                    fanoutMode,
                    ...(fanoutContext.child ? { fanoutChildKey: fanoutContext.child.key } : {}),
                    messageId: source.id,
                } : {}),
                instruction: [
                    `You are ${coworker.name}.`,
                    `Role: ${coworker.role}`,
                    coworker.instructions ? `Working instructions: ${coworker.instructions}` : "",
                    "Respond to the newest message as this persistent coworker. Preserve continuity with the conversation, be action-oriented, and do not claim work you did not actually complete.",
                    artifactStore ? artifactPromptInstruction() : "",
                    handoffPromptInstruction(availableHandoffs),
                    !fanoutMode && !pendingProtocol ? fanoutPromptInstruction(availableHandoffs) : "",
                    fanoutPrompt(fanoutMode, fanoutContext, conversationId),
                    pendingProtocol?.kind === "review" || fanoutMode === "review" ? reviewPromptInstruction() : "",
                    pendingProtocol?.kind === "review" && pendingProtocol.candidateArtifactIds?.length
                        ? `Review candidate ArtifactStore IDs: ${pendingProtocol.candidateArtifactIds.join(", ")}. Use only these opaque IDs when referring to the candidate.`
                        : "",
                    artifactStore && availableHandoffs.length ? "If both files and a handoff are needed, put the SOVEREIGN_ARTIFACTS line first and the SOVEREIGN_HANDOFFS line last." : "",
                ].filter(Boolean).join("\n"),
                conversation: publicConversationContext(conversation, coworkerId),
                newestMessageId: source.id,
            },
        }, context, supervisorAgentId);

        if (!fanoutMode)
            task = await bindContinuation(task, turn.lastTaskId, binding.agentId, binding.harnessKind, binding.accountNamespace, turn.accountNamespace);
        const activeKey = stateKey(conversationId, coworkerId);
        activeTasks.set(activeKey, task.id);
        if (fanoutMode) {
            const preflight = runtime.orchestrator.preflightTrustedTask;
            const reusedCompletedTask = stableFanoutTask?.status === "completed";
            if (!reusedCompletedTask && typeof preflight !== "function") {
                await runtime.orchestrator.cancel(task.id, { reason: "trusted Governor preflight is unavailable", actor: "runtime" }).catch(() => {});
                await blockPendingFanout("The trusted Governor preflight is unavailable.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The trusted Governor preflight is unavailable.");
                return { ok: false, taskId: task.id, attention: true, reason: "trusted Governor preflight is unavailable" };
            }
            const launch = reusedCompletedTask ? { allowed: true, agentId: binding.agentId, task } : await preflight.call(runtime.orchestrator, task.id);
            if (!launch?.allowed) {
                await blockPendingFanout(launch?.reason ?? "The trusted Governor rejected this fan-out child.");
                if (launch?.task?.status === "queued") await runtime.orchestrator.cancel(task.id, { reason: launch?.reason ?? "trusted Governor preflight failed", actor: "runtime" }).catch(() => {});
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", launch?.reason ?? "trusted Governor preflight failed");
                return { ok: false, taskId: task.id, attention: true, reason: launch?.reason ?? "trusted Governor preflight failed" };
            }
            try {
                if (fanoutMode === "child") teamFlow.acceptFanoutChild({ conversationId, childKey: fanoutContext.child.key, coworkerId, messageId, taskId: task.id, workspaceId: context.workspaceId });
                else if (fanoutMode === "review") teamFlow.acceptFanoutReview({ conversationId, coworkerId, messageId });
                else teamFlow.acceptFanoutJoin({ conversationId, coworkerId, messageId });
            }
            catch (error) {
                await runtime.orchestrator.cancel(task.id, { reason: "fan-out protocol acceptance failed", actor: "runtime" }).catch(() => {});
                await blockPendingFanout("The fan-out protocol could not be accepted safely.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The fan-out protocol could not be accepted safely.");
                return { ok: false, taskId: task.id, attention: true, reason: String(error?.message ?? error) };
            }
        }
        else if (pendingProtocol) {
            const preflight = runtime.orchestrator.preflightTrustedTask;
            if (typeof preflight !== "function") {
                await runtime.orchestrator.cancel(task.id, { reason: "trusted Governor preflight is unavailable", actor: "runtime" }).catch(() => {});
                await blockPendingProtocol("The trusted Governor preflight is unavailable.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The trusted Governor preflight is unavailable.");
                return { ok: false, taskId: task.id, attention: true, reason: "trusted Governor preflight is unavailable" };
            }
            const launch = await preflight.call(runtime.orchestrator, task.id);
            if (!launch?.allowed) {
                await blockPendingProtocol(launch?.reason ?? "The trusted Governor rejected this work.");
                if (launch?.task?.status === "queued") await runtime.orchestrator.cancel(task.id, { reason: launch?.reason ?? "trusted Governor preflight failed", actor: "runtime" }).catch(() => {});
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", launch?.reason ?? "The trusted Governor rejected this work.");
                return { ok: false, taskId: task.id, attention: true, reason: launch?.reason ?? "trusted Governor preflight failed" };
            }
            try {
                const proof = teamFlow?.pendingProtocolProof?.(conversationId);
                teamFlow.acceptProtocol({ conversationId, targetCoworkerId: coworkerId, proofId: proof?.proofId, messageId: source.id, ...stageContext, expectedVersion: stageContext.version });
                stageContext = teamFlow.collaborationContextForConversation(conversationId);
            } catch (error) {
                await runtime.orchestrator.cancel(task.id, { reason: "protocol acceptance failed", actor: "runtime" }).catch(() => {});
                await blockPendingProtocol("The protocol could not be accepted safely.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The protocol could not be accepted safely.");
                return { ok: false, taskId: task.id, attention: true, reason: String(error?.message ?? error) };
            }
        }
        if (!fanoutMode)
            teamFlow?.claimStage?.({ conversationId, ownerId: coworkerId, messageId: source.id, ...(stageContext ? { ...stageContext, expectedVersion: stageContext.version } : {}) });
        const executionContext = teamFlow?.collaborationContextForConversation?.(conversationId);
        if (isConversationBlocked(conversationId)) {
            await runtime.orchestrator.cancel(task.id, { reason: "conversation was blocked before provider execution", actor: "external-team-control" }).catch(() => {});
            return { ok: false, taskId: task.id, stopped: true, reason: "conversation is blocked for takeover or cancellation" };
        }
        await runtime.orchestrator.runUntilIdle();
        const finished = (await runtime.orchestrator.listTasks()).find((entry) => entry.id === task.id);
        const resultGate = fanoutMode
            ? fanoutPublishGate(conversationId, messageId, coworkerId, { fanoutId: fanoutContext.fanout.fanoutId, childKey: fanoutContext.child?.key, taskId: task.id, runId: executionContext?.runId }, fanoutMode)
            : publishGate(conversationId, messageId, coworkerId, executionContext);
        if (!resultGate)
            return { ok: false, taskId: task.id, stopped: true, reason: "stale collaboration result was discarded" };
        if (finished?.status !== "completed") {
            const detail = "Coworker work did not complete.";
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", detail);
            if (fanoutMode) await blockPendingFanout(detail);
            else recordTeamEvent({ conversationId, type: "work.failed", status: "failed", actorId: coworkerId, ownerId: coworkerId, messageId, reason: detail });
            state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
            save();
            return { ok: false, taskId: task.id, error: detail };
        }

        if (isConversationBlocked(conversationId)) {
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "automation stopped for takeover or cancellation");
            recordTeamEvent({ conversationId, type: "work.failed", status: "stopped", actorId: coworkerId, ownerId: coworkerId, messageId, reason: "Work was stopped before the result could be published." });
            return { ok: false, taskId: task.id, stopped: true, reason: "conversation is blocked for takeover or cancellation" };
        }

        const rawText = typeof finished.result?.text === "string"
            ? redactWorkspacePath(finished.result.text, context.cwd).trim().slice(0, MAX_REPLY_TEXT)
            : "";
        if (!rawText) {
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "provider returned no text reply");
            recordTeamEvent({ conversationId, type: "work.failed", status: "failed", actorId: coworkerId, ownerId: coworkerId, messageId, reason: "The coworker returned no usable result." });
            return { ok: false, taskId: task.id, error: "provider returned no text reply" };
        }

        const reviewResult = (pendingProtocol?.kind === "review" || fanoutMode === "review")
            ? extractReviewDecision(rawText)
            : { text: rawText };
        if (reviewResult.invalidDecision) {
            await runtime.audit.append({
                type: "coworker.review_decision_rejected",
                actor: coworkerAgentId(coworkerId),
                subject: task.id,
                data: { conversationId, messageId },
            });
        }
        const fanoutResult = !fanoutMode && !pendingProtocol
            ? extractFanoutManifest(reviewResult.text, availableHandoffs.map((entry) => entry.id))
            : { text: reviewResult.text, children: [] };
        if (fanoutResult.invalidManifest) {
            await runtime.audit.append({
                type: "coworker.fanout_manifest_rejected",
                actor: coworkerAgentId(coworkerId),
                subject: task.id,
                data: { conversationId, messageId },
            });
        }
        const handoffResult = extractHandoffManifest(fanoutResult.text, availableHandoffs.map((entry) => entry.id));
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
            protocolContext: executionContext,
        });
        const createdArtifactIds = artifactResult.artifactIds;
        const ingestGate = fanoutMode
            ? fanoutPublishGate(conversationId, messageId, coworkerId, { fanoutId: fanoutContext.fanout.fanoutId, childKey: fanoutContext.child?.key, taskId: task.id, runId: executionContext?.runId }, fanoutMode)
            : publishGate(conversationId, messageId, coworkerId, executionContext);
        if (!ingestGate) {
            discardArtifacts(createdArtifactIds);
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "stale collaboration result was discarded");
            return { ok: false, taskId: task.id, stopped: true, reason: "stale collaboration result was discarded" };
        }
        const visibleText = artifactResult.text || (artifactResult.artifactIds.length ? `Created ${artifactResult.artifactIds.length} artifact${artifactResult.artifactIds.length === 1 ? "" : "s"}.` : "Completed the requested work.");
        if (fanoutResult.children.length) {
            let requested;
            try {
                requested = teamFlow.requestFanout({
                    conversationId,
                    ownerCoworkerId: coworkerId,
                    sourceMessageId: source.id,
                    reviewerCoworkerId: fanoutResult.reviewerCoworkerId,
                    children: fanoutResult.children,
                    ...(executionContext ? { ...executionContext, expectedVersion: executionContext.version } : {}),
                });
            }
            catch (error) {
                discardArtifacts(createdArtifactIds);
                throw error;
            }
            const childIds = requested.children.map((entry) => entry.coworkerId);
            const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, {
                text: visibleText.slice(0, MAX_REPLY_TEXT),
                replyTo: source.id,
                mentions: childIds,
            });
            teamFlow.bindFanoutMessage({ conversationId, kind: "owner", messageId: reply.id, expectedFanoutId: requested.fanoutId });
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "delivered");
            state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
            save();
            dispatchMessage(conversationId, reply.id);
            return { ok: true, taskId: task.id, reply, artifacts: [], handoffs: childIds };
        }
        if (fanoutMode === "child") {
            try {
                teamFlow.completeFanoutChild({ conversationId, childKey: fanoutContext.child.key, coworkerId, taskId: task.id, artifactIds: artifactResult.artifactIds, resultText: visibleText });
            }
            catch (error) {
                discardArtifacts(createdArtifactIds);
                throw error;
            }
            const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, { text: visibleText.slice(0, MAX_REPLY_TEXT), replyTo: source.id });
            closeInternalReply(conversationId, reply);
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "delivered");
            state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
            save();
            const afterChild = teamFlow.fanoutContextForConversation?.(conversationId)?.activeFanout;
            if (afterChild?.state === "running" && afterChild.children.every((entry) => entry.state === "completed")) {
                teamFlow.requestFanoutReview({ conversationId });
                const reviewMessage = conversationStore.postCoworkerMessage(conversationId, coworkerId, {
                    text: "Parallel specialist results are ready for the required independent review.",
                    replyTo: source.id,
                    mentions: [afterChild.reviewerCoworkerId],
                });
                teamFlow.bindFanoutMessage({ conversationId, kind: "review", messageId: reviewMessage.id, expectedFanoutId: afterChild.fanoutId });
                dispatchMessage(conversationId, reviewMessage.id);
            }
            return { ok: true, taskId: task.id, reply, artifacts: [], handoffs: [] };
        }
        if (fanoutMode === "review") {
            if (!reviewResult.decision) {
                discardArtifacts(createdArtifactIds);
                await blockPendingFanout("The independent reviewer returned no valid decision.");
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "The independent reviewer returned no valid decision.");
                return { ok: false, taskId: task.id, attention: true, reason: "The independent reviewer returned no valid decision." };
            }
            discardArtifacts(createdArtifactIds);
            const reviewed = teamFlow.completeFanoutReview({ conversationId, coworkerId, decision: reviewResult.decision, resultText: reviewResult.text });
            const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, { text: reviewResult.text || (reviewResult.decision === "approved" ? "Independent review approved." : "Independent review requested changes."), replyTo: source.id });
            closeInternalReply(conversationId, reply);
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "delivered");
            state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
            save();
            if (reviewed.state === "join_requested") {
                const joinMessage = conversationStore.postCoworkerMessage(conversationId, coworkerId, {
                    text: "Independent review approved; the original owner will now join the specialist results.",
                    replyTo: source.id,
                    mentions: [reviewed.ownerCoworkerId],
                });
                teamFlow.bindFanoutMessage({ conversationId, kind: "join", messageId: joinMessage.id, expectedFanoutId: reviewed.fanoutId });
                dispatchMessage(conversationId, joinMessage.id);
            }
            return { ok: true, taskId: task.id, reply, artifacts: [], handoffs: [] };
        }
        if (fanoutMode === "join") {
            const summary = teamFlow.fanoutJoinSummary(conversationId);
            const publishArtifactIds = [...new Set([...(summary?.children ?? []).flatMap((entry) => entry.artifactIds ?? []), ...artifactResult.artifactIds])];
            try {
                teamFlow.completeFanoutJoin({ conversationId, coworkerId, taskId: task.id, artifactIds: publishArtifactIds, expectedFanoutId: fanoutContext.fanout.fanoutId });
                artifactStore?.publishArtifacts?.(publishArtifactIds);
            }
            catch (error) {
                discardArtifacts(createdArtifactIds);
                throw error;
            }
            const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, { text: visibleText.slice(0, MAX_REPLY_TEXT), replyTo: source.id, ...(publishArtifactIds.length ? { artifactIds: publishArtifactIds } : {}) });
            closeInternalReply(conversationId, reply);
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "delivered");
            state.turns[stateKey(conversationId, coworkerId)] = { lastTaskId: task.id, provider: binding.provider, ...(binding.accountNamespace ? { accountNamespace: binding.accountNamespace } : {}), updatedAt: now() };
            save();
            return { ok: true, taskId: task.id, reply, artifacts: publishArtifactIds, handoffs: [] };
        }
        const protocol = executionContext?.activeProtocol;
        let resultContext = executionContext;
        if (protocol) {
            try {
                teamFlow.submitProtocolResult({ conversationId, coworkerId, messageId: source.id, artifactIds: artifactResult.artifactIds, ...executionContext, expectedVersion: executionContext.version, idempotencyKey: protocol.kind + ".result:" + source.id });
            } catch (error) {
                discardArtifacts(createdArtifactIds);
                throw error;
            }
            resultContext = teamFlow.collaborationContextForConversation(conversationId);
        }
        else {
            recordTeamEvent({ conversationId, type: "work.completed", status: "completed", actorId: coworkerId, ownerId: coworkerId, messageId: source.id, artifactIds: artifactResult.artifactIds, reason: "Result is ready for the next team step." });
            resultContext = teamFlow?.collaborationContextForConversation?.(conversationId) ?? executionContext;
        }
        const isReview = protocol?.kind === "review";
        const protocolArtifactIds = isReview ? (resultContext?.activeProtocol?.candidateArtifactIds ?? []) : [];
        const publishArtifactIds = artifactResult.artifactIds.length ? artifactResult.artifactIds : protocolArtifactIds;
        let reviewDecision;
        let decisionContext = resultContext;
        if (isReview) {
            reviewDecision = reviewResult.decision;
            if (!reviewDecision) {
                discardArtifacts(createdArtifactIds);
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "review decision was not approved by the protocol");
                recordTeamEvent({ conversationId, type: "work.failed", status: "attention", actorId: coworkerId, ownerId: coworkerId, messageId: source.id, artifactIds: artifactResult.artifactIds, reason: "The reviewer returned no valid decision." });
                return { ok: false, taskId: task.id, attention: true, reason: "The reviewer returned no valid decision." };
            }
            try {
                teamFlow.recordReviewDecision({ conversationId, coworkerId, messageId: source.id, decision: reviewDecision, artifactIds: publishArtifactIds, ...resultContext, expectedVersion: resultContext.version, idempotencyKey: "review.decision:" + protocol.protocolRequestId + ":" + protocol.revision + ":" + reviewDecision });
            } catch (error) {
                discardArtifacts(createdArtifactIds);
                throw error;
            }
            decisionContext = teamFlow.collaborationContextForConversation(conversationId);
            if (decisionContext.activeProtocol?.state === "blocked") {
                discardArtifacts(createdArtifactIds);
                conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "review revision limit was reached");
                return { ok: false, taskId: task.id, attention: true, reason: "The review revision limit was reached." };
            }
        }
        const reviewRevisionTarget = isReview && reviewDecision === "changes-requested"
            ? decisionContext.activeProtocol?.sourceCoworkerId
            : undefined;
        const handoffIds = reviewRevisionTarget ? [reviewRevisionTarget] : handoffResult.coworkerIds;
        const proposedTarget = reviewRevisionTarget ?? teamFlow?.previewHandoff?.({
            conversation,
            coworkerId,
            source,
            requestedCoworkerIds: handoffIds,
        });
        let runtimeProof;
        let handoffBlocked = false;
        if (proposedTarget) {
            try {
                const handoffContext = teamFlow?.collaborationContextForConversation?.(conversationId);
                runtimeProof = teamFlow?.authorizeHandoffTarget?.({
                    conversationId,
                    sourceCoworkerId: coworkerId,
                    targetCoworkerId: proposedTarget,
                    ...(handoffContext ? {
                        expectedVersion: handoffContext.version,
                        expectedRunId: handoffContext.runId,
                        expectedRequestId: handoffContext.requestId,
                        expectedOperationId: handoffContext.operationId,
                        expectedOperationToken: handoffContext.operationToken,
                    } : {}),
                });
                if (teamFlow?.authorizeHandoffTarget && !runtimeProof) throw new Error("handoff runtime proof was not created");
            }
            catch {
                handoffBlocked = true;
            }
        }
        if (handoffBlocked)
            recordTeamEvent({ conversationId, type: "handoff.blocked", status: "attention", actorId: coworkerId, ownerId: coworkerId, targetCoworkerId: proposedTarget, messageId: source.id, reason: "The next teammate is not ready to receive this work." });
        const productHandoff = handoffBlocked ? undefined : proposedTarget;
        // A Team Pack may own a bounded playbook sequence.  Its next stage is a
        // product routing decision, not authority supplied by model output; explicit
        // manifests remain available for ordinary user-created teams.
        const managedTeam = conversation.kind === "team" && teamFlow?.isManagedConversation?.(conversation.id);
        const nextCoworkerIds = productHandoff
            ? [productHandoff]
            : managedTeam
                ? []
                : handoffResult.coworkerIds.slice(0, 1);
        const targetIsReview = Boolean(!isReview && productHandoff && teamFlow?.isReviewerForConversation?.(conversationId, productHandoff));
        const shouldPublishResult = isReview ? reviewDecision === "approved" : !targetIsReview;
        const publishContext = decisionContext ?? resultContext ?? executionContext;
        if (shouldPublishResult && !publishGate(conversationId, messageId, coworkerId, publishContext)) {
            conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", "stale collaboration result was discarded");
            return { ok: false, taskId: task.id, stopped: true, reason: "stale collaboration result was discarded" };
        }
        if (shouldPublishResult) {
            const lineage = publishContext?.activeProtocol ? {
                runId: publishContext.runId,
                requestId: publishContext.requestId,
                operationId: publishContext.operationId,
                protocolRequestId: publishContext.activeProtocol.protocolRequestId,
                revision: publishContext.activeProtocol.revision,
            } : undefined;
            const protocolLineages = isReview && artifactStore?.protocolLineageFor
                ? Object.fromEntries(publishArtifactIds.map((id) => [id, artifactStore.protocolLineageFor(id)]))
                : undefined;
            if (protocolLineages && Object.values(protocolLineages).some((entry) => !entry || entry.runId !== publishContext.runId || entry.revision !== publishContext.activeProtocol.revision)) {
                discardArtifacts(createdArtifactIds);
                throw new Error("protocol artifact lineage is stale");
            }
            try {
                artifactStore?.publishArtifacts?.(publishArtifactIds, protocolLineages ? { protocolLineages } : lineage ? { protocolLineage: lineage } : undefined);
            }
            catch (error) {
                discardArtifacts(createdArtifactIds);
                throw error;
            }
        }
        const reply = conversationStore.postCoworkerMessage(conversationId, coworkerId, {
            text: visibleText.slice(0, MAX_REPLY_TEXT),
            replyTo: source.id,
            ...(nextCoworkerIds.length ? { mentions: nextCoworkerIds } : {}),
            ...(shouldPublishResult && publishArtifactIds.length ? { artifactIds: publishArtifactIds } : {}),
        });
        if (!handoffBlocked && (productHandoff || managedTeam)) {
            const handoffContext = teamFlow?.collaborationContextForConversation?.(conversationId);
            teamFlow?.nextHandoff?.({
                conversation,
                coworkerId,
                source,
                requestedCoworkerIds: handoffIds,
                replyText: artifactResult.text,
                runtimeProof,
                expectedTargetCoworkerId: productHandoff,
                ...(handoffContext ? {
                    expectedVersion: handoffContext.version,
                    expectedRunId: handoffContext.runId,
                    expectedRequestId: handoffContext.requestId,
                    expectedOperationId: handoffContext.operationId,
                    expectedOperationToken: handoffContext.operationToken,
                } : {}),
            });
        }
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
        return { ok: true, taskId: task.id, reply, artifacts: publishArtifactIds, handoffs: nextCoworkerIds };
    }

    function scheduleDelivery(conversationId, messageId, coworkerId) {
        const key = stateKey(conversationId, coworkerId);
        const previous = chains.get(key) ?? Promise.resolve();
        const run = previous
            .then(() => executeDelivery(conversationId, messageId, coworkerId))
            .catch((error) => {
                const detail = "Coworker work could not start or complete.";
                try { conversationStore.markDelivery(conversationId, messageId, coworkerId, "failed", detail); } catch {}
                let ledgerFailure = false;
                try { recordTeamEvent({ conversationId, type: "work.failed", status: "failed", actorId: coworkerId, ownerId: coworkerId, messageId, reason: detail }); }
                catch { ledgerFailure = true; }
                return { ok: false, error: detail, ...(ledgerFailure ? { attention: true, reason: "Team activity could not be recorded." } : {}) };
            });
        chains.set(key, run);
        run.finally(() => {
            if (chains.get(key) === run)
                chains.delete(key);
            activeTasks.delete(key);
        }).catch(() => {});
        return run;
    }

    async function stopConversation(conversationId, reason = "conversation stopped by the user", actor = "desktop-operator", expectedContext) {
        const controlContext = expectedContext ?? teamFlow?.collaborationContextForConversation?.(conversationId);
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
        teamFlow?.stopRun?.(conversationId, reason, controlContext);
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
