import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { selectSpecialist } from "./lib/specialist-router.js";

export const TEAMS_SCHEMA = "sovereignbot.desktop.teams.v1";
export const TEAM_PACK_EXPORT_SCHEMA = "sovereignbot.desktop.team-pack.v1";
export const TEAM_PLAYBOOK_EXPORT_SCHEMA = "sovereignbot.desktop.playbook.v1";
export const COLLABORATION_SCHEMA = "sovereignbot.desktop.collaboration.v1";

const MAX_TEAMS = 32;
const MAX_CHANNELS = 128;
const MAX_COLLABORATION_RUNS = 128;
const MAX_COLLABORATION_EVENTS = 1_024;
const TEAM_ID = /^team_[a-f0-9]{16}$/i;
const CHANNEL_ID = /^channel_[a-f0-9]{16}$/i;
const COLLABORATION_ID = /^(run|request|operation|event|token)_[a-f0-9]{16}$/i;
const COLLABORATION_EVENT_TYPES = new Set([
    "run.started", "work.started", "handoff.requested", "work.completed", "run.completed",
    "work.failed", "handoff.blocked", "run.stopped", "run.redirected",
    "handoff.accepted", "handoff.result", "review.requested", "review.accepted",
    "review.submitted", "review.decision", "fanout.requested", "fanout.child.started",
    "fanout.child.submitted", "fanout.review.requested", "fanout.review.started",
    "fanout.reviewed", "fanout.join.requested", "fanout.joined",
    "fanout.blocked",
]);
const COLLABORATION_STATUSES = new Set(["active", "completed", "failed", "attention", "stopped", "redirected"]);
const PROTOCOL_KINDS = new Set(["handoff", "review"]);
const PROTOCOL_STATES = new Set([
    "requested", "accepted", "working", "submitted", "review_requested", "review_accepted",
    "reviewing", "approved", "changes_requested", "completed", "blocked", "stopped", "redirected",
]);
const MAX_PROTOCOL_REVISIONS = 2;
const PROTOCOL_REQUEST_EVENTS = new Set(["run.started", "handoff.requested", "review.requested"]);
const FANOUT_STATES = new Set(["requested", "running", "review_requested", "reviewing", "join_requested", "joining", "completed", "blocked", "stopped", "redirected"]);
const FANOUT_CHILD_STATES = new Set(["requested", "running", "completed", "failed", "stopped"]);
const MAX_FANOUT_CHILDREN = 4;
const MAX_FANOUT_TEXT = 2_000;

export const SOFTWARE_TEAM_PACK = Object.freeze({
    id: "software-team",
    name: "Software Team",
    description: "A small delivery team that scopes, implements, reviews, and reports the result.",
    coworkers: Object.freeze([
        {
            key: "chief",
            name: "Chief of Staff",
            role: "Own the outcome and coordinate the software delivery.",
            instructions: "Scope the desired outcome, delegate implementation to Coding Lead, ask Reviewer to check the result, then synthesize the final answer for the user.",
            avatar: "✦",
            modelBinding: { profile: "automatic" },
        },
        {
            key: "coding-lead",
            name: "Coding Lead",
            role: "Implement and validate the requested software change.",
            instructions: "Work in the shared project workspace, make focused changes, run the smallest useful checks, and return an honest implementation result for review.",
            avatar: "⌘",
            modelBinding: { profile: "efficient", provider: "codex" },
        },
        {
            key: "reviewer",
            name: "Reviewer",
            role: "Review the implementation and report risks or approval.",
            instructions: "Review the Coding Lead result independently, identify concrete issues, and give the Chief a concise go/no-go assessment.",
            avatar: "✓",
            modelBinding: { profile: "efficient", provider: "codex" },
        },
    ]),
    channels: Object.freeze([
        {
            key: "project",
            name: "Project Channel",
            kind: "project",
            instructions: "Software Delivery: Chief scopes the outcome, Coding Lead implements, Reviewer reviews, and Chief synthesizes the result.",
            playbookId: "software-delivery",
        },
    ]),
    playbooks: Object.freeze([
        {
            id: "software-delivery",
            name: "Software Delivery",
            description: "Chief scopes → Coding Lead implements → Reviewer reviews → Chief synthesizes.",
            steps: Object.freeze(["chief", "coding-lead", "reviewer", "chief"]),
        },
    ]),
});

function createSimpleTeamPack({ id, name, description, specialistName, specialistRole, specialistInstructions, channelName, channelInstructions, playbookId, playbookName, playbookDescription }) {
    return Object.freeze({
        id,
        name,
        description,
        coworkers: Object.freeze([
            {
                key: "chief",
                name: "Chief of Staff",
                role: "Own the outcome and coordinate the team.",
                instructions: `Scope the desired outcome, delegate the work to ${specialistName}, ask the Reviewer to check it, then synthesize the final answer for the user.`,
                avatar: "✦",
                modelBinding: { profile: "automatic" },
            },
            {
                key: "specialist",
                name: specialistName,
                role: specialistRole,
                instructions: specialistInstructions,
                avatar: "⌘",
                modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
            },
            {
                key: "reviewer",
                name: "Reviewer",
                role: "Review the specialist result and report risks or approval.",
                instructions: "Review the specialist result independently, identify concrete issues, and give the Chief a concise go/no-go assessment.",
                avatar: "✓",
                modelBinding: { profile: "efficient", provider: "codex", model: "luna" },
            },
        ]),
        channels: Object.freeze([
            {
                key: "project",
                name: channelName,
                kind: "project",
                instructions: channelInstructions,
                playbookId,
            },
        ]),
        playbooks: Object.freeze([
            {
                id: playbookId,
                name: playbookName,
                description: playbookDescription,
                steps: Object.freeze(["chief", "specialist", "reviewer", "chief"]),
            },
        ]),
    });
}

export const RESEARCH_TEAM_PACK = createSimpleTeamPack({
    id: "research-team",
    name: "Research Team",
    description: "A focused research team that frames a question, investigates it, reviews evidence, and reports the result.",
    specialistName: "Research Lead",
    specialistRole: "Investigate the question and synthesize grounded findings.",
    specialistInstructions: "Investigate the bounded question, separate evidence from inference, cite the available sources, and return a concise findings brief for review.",
    channelName: "Research Room",
    channelInstructions: "Research Brief: Chief frames the question, Research Lead investigates, Reviewer checks evidence, and Chief reports the result.",
    playbookId: "research-brief",
    playbookName: "Research Brief",
    playbookDescription: "Chief frames → Research Lead investigates → Reviewer checks evidence → Chief reports.",
});

export const CONTENT_TEAM_PACK = createSimpleTeamPack({
    id: "content-team",
    name: "Content Team",
    description: "A compact content team that shapes a brief, drafts the piece, reviews it, and delivers a polished result.",
    specialistName: "Content Lead",
    specialistRole: "Turn the brief into a clear, audience-ready draft.",
    specialistInstructions: "Turn the bounded brief into a useful draft, preserve the requested voice and facts, and return the deliverable for review.",
    channelName: "Content Studio",
    channelInstructions: "Content Delivery: Chief shapes the brief, Content Lead drafts, Reviewer checks quality, and Chief delivers the result.",
    playbookId: "content-delivery",
    playbookName: "Content Delivery",
    playbookDescription: "Chief briefs → Content Lead drafts → Reviewer checks quality → Chief delivers.",
});

export const OPERATIONS_TEAM_PACK = createSimpleTeamPack({
    id: "operations-team",
    name: "Operations Team",
    description: "A practical operations team that scopes a runbook, carries out bounded work, reviews it, and reports status.",
    specialistName: "Operations Lead",
    specialistRole: "Execute bounded operational work and keep the runbook current.",
    specialistInstructions: "Execute only the bounded operational objective, record what changed and what remains, and return an honest runbook update for review.",
    channelName: "Operations Room",
    channelInstructions: "Operations Runbook: Chief scopes the work, Operations Lead executes, Reviewer checks the result, and Chief reports status.",
    playbookId: "operations-runbook",
    playbookName: "Operations Runbook",
    playbookDescription: "Chief scopes → Operations Lead executes → Reviewer checks → Chief reports.",
});

export const PRODUCT_TEAM_PACK = createSimpleTeamPack({
    id: "product-team",
    name: "Product Discovery Team",
    description: "A product discovery team that frames user problems, shapes a decision-ready brief, reviews trade-offs, and reports next steps.",
    specialistName: "Product Lead",
    specialistRole: "Turn user needs and evidence into a bounded product decision.",
    specialistInstructions: "Frame the user problem, distinguish evidence from assumptions, propose a concise product brief with acceptance criteria and trade-offs, and return a decision-ready draft for review. Do not promise implementation or access external systems.",
    channelName: "Product Discovery",
    channelInstructions: "Product Discovery: Chief frames the outcome, Product Lead shapes the problem brief and criteria, Reviewer checks assumptions and trade-offs, and Chief reports the decision path.",
    playbookId: "product-discovery",
    playbookName: "Product Discovery",
    playbookDescription: "Chief frames → Product Lead shapes the brief → Reviewer checks trade-offs → Chief reports.",
});

export const REVENUE_TEAM_PACK = createSimpleTeamPack({
    id: "revenue-team",
    name: "Revenue Planning Team",
    description: "A revenue planning team that organizes account context, evaluates commercial options, reviews assumptions, and reports a bounded plan.",
    specialistName: "Revenue Lead",
    specialistRole: "Turn supplied account and deal context into grounded commercial planning.",
    specialistInstructions: "Use only the account or deal context supplied by the user, separate facts from assumptions, summarize qualification and forecast considerations, and draft a bounded next-step plan for review. Do not contact prospects, change CRM records, or make financial commitments.",
    channelName: "Revenue Planning",
    channelInstructions: "Revenue Planning: Chief frames the commercial question, Revenue Lead analyzes supplied context, Reviewer checks assumptions and risks, and Chief reports the planning recommendation.",
    playbookId: "revenue-planning",
    playbookName: "Revenue Planning",
    playbookDescription: "Chief frames → Revenue Lead analyzes context → Reviewer checks assumptions → Chief reports.",
});

export const SUPPORT_TEAM_PACK = createSimpleTeamPack({
    id: "support-team",
    name: "Customer Support Team",
    description: "A customer support team that triages supplied cases, drafts grounded replies, reviews risks, and recommends escalation.",
    specialistName: "Support Lead",
    specialistRole: "Turn supplied customer context into a safe triage and reply draft.",
    specialistInstructions: "Triage only the customer case details supplied by the user, identify the issue and missing facts, draft a grounded reply with uncertainty called out, and recommend escalation when needed. Do not send messages, alter tickets, issue refunds, or invent customer data.",
    channelName: "Support Triage",
    channelInstructions: "Support Triage: Chief frames the case, Support Lead drafts triage and a grounded reply, Reviewer checks tone and risk, and Chief reports the recommended next step.",
    playbookId: "support-triage",
    playbookName: "Support Triage",
    playbookDescription: "Chief frames → Support Lead triages and drafts → Reviewer checks risk → Chief reports.",
});

export const TEAM_PACKS = Object.freeze([
    SOFTWARE_TEAM_PACK,
    RESEARCH_TEAM_PACK,
    CONTENT_TEAM_PACK,
    OPERATIONS_TEAM_PACK,
    PRODUCT_TEAM_PACK,
    REVENUE_TEAM_PACK,
    SUPPORT_TEAM_PACK,
]);

const TEAM_PACK_BY_ID = new Map(TEAM_PACKS.map((pack) => [pack.id, pack]));
const TEAM_PACK_CATEGORY = new Map([
    ["software-team", "Software"],
    ["research-team", "Research"],
    ["content-team", "Content"],
    ["operations-team", "Operations"],
    ["product-team", "Product"],
    ["revenue-team", "Sales"],
    ["support-team", "Support"],
]);

export const CHANNEL_TEMPLATES = Object.freeze([
    Object.freeze({
        id: "work",
        name: "Work Channel",
        kind: "work",
        instructions: "A focused work room for bounded tasks, progress updates, and teammate handoffs.",
    }),
    Object.freeze({
        id: "personal",
        name: "Personal Channel",
        kind: "personal",
        instructions: "A private-feeling planning room for the user's own context and next actions.",
    }),
    Object.freeze({
        id: "project",
        name: "Project Channel",
        kind: "project",
        instructions: "A shared project room for goals, artifacts, ownership, and a visible final result.",
    }),
]);

const CHANNEL_TEMPLATE_BY_ID = new Map(CHANNEL_TEMPLATES.map((template) => [template.id, template]));

function idFactory(prefix) {
    return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
    return structuredClone(value);
}

function safeString(value, label, max = 200) {
    if (typeof value !== "string" || !value.trim() || value.length > max)
        throw new Error(`${label} must be a non-empty bounded string`);
    return value.trim();
}

function safeOptionalString(value, label, max = 200) {
    if (typeof value !== "string" || value.length > max)
        throw new Error(`${label} must be a bounded string`);
    return value.trim();
}

function safeId(value, label, pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) {
    if (typeof value !== "string" || !pattern.test(value))
        throw new Error(`${label} must be an identifier`);
    return value;
}

function safeSemanticIdList(value, label, max) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} identifiers`);
    return [...new Set(value.map((entry) => safeId(entry, label)))];
}

function safePlaybookSemantics(value) {
    const out = {};
    if (value.stages !== undefined) {
        if (!Array.isArray(value.stages) || value.stages.length > 8) throw new Error("playbook stages must be an array of at most 8 stages");
        out.stages = value.stages.map((stage) => {
            if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error("playbook stage must be an object");
            const allowed = new Set(["id", "name", "instructions", "expectedOutput", "recommendedCoworkerRole", "recommendedSkillIds"]);
            for (const key of Object.keys(stage)) if (!allowed.has(key)) throw new Error(`playbook stage field is not allowed: ${key}`);
            return {
                id: safeId(stage.id, "playbook stage id"),
                name: safeString(stage.name, "playbook stage name", 120),
                instructions: safeOptionalString(stage.instructions ?? "", "playbook stage instructions", 2_000),
                ...(stage.expectedOutput === undefined ? {} : { expectedOutput: safeOptionalString(stage.expectedOutput, "playbook stage expectedOutput", 500) }),
                ...(stage.recommendedCoworkerRole === undefined ? {} : { recommendedCoworkerRole: safeOptionalString(stage.recommendedCoworkerRole, "playbook stage recommendedCoworkerRole", 120) }),
                ...(stage.recommendedSkillIds === undefined ? {} : { recommendedSkillIds: safeSemanticIdList(stage.recommendedSkillIds, "playbook stage recommendedSkillId", 8) }),
            };
        });
    }
    if (value.reviewPoints !== undefined) {
        if (!Array.isArray(value.reviewPoints) || value.reviewPoints.length > 8) throw new Error("playbook reviewPoints must be an array of at most 8 review points");
        out.reviewPoints = value.reviewPoints.map((point) => {
            if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("playbook review point must be an object");
            const allowed = new Set(["id", "name", "instructions", "recommendedCoworkerRole", "recommendedSkillIds"]);
            for (const key of Object.keys(point)) if (!allowed.has(key)) throw new Error(`playbook review point field is not allowed: ${key}`);
            return {
                id: safeId(point.id, "playbook review point id"),
                name: safeString(point.name, "playbook review point name", 120),
                instructions: safeOptionalString(point.instructions ?? "", "playbook review point instructions", 2_000),
                ...(point.recommendedCoworkerRole === undefined ? {} : { recommendedCoworkerRole: safeOptionalString(point.recommendedCoworkerRole, "playbook review point recommendedCoworkerRole", 120) }),
                ...(point.recommendedSkillIds === undefined ? {} : { recommendedSkillIds: safeSemanticIdList(point.recommendedSkillIds, "playbook review point recommendedSkillId", 8) }),
            };
        });
    }
    if (value.expectedOutput !== undefined) out.expectedOutput = safeOptionalString(value.expectedOutput, "playbook expectedOutput", 500);
    if (value.recommendedCoworkerRoles !== undefined) {
        if (!Array.isArray(value.recommendedCoworkerRoles) || value.recommendedCoworkerRoles.length > 8) throw new Error("playbook recommendedCoworkerRoles must contain at most 8 roles");
        out.recommendedCoworkerRoles = [...new Set(value.recommendedCoworkerRoles.map((role) => safeString(role, "playbook recommendedCoworkerRole", 120)))];
    }
    if (value.recommendedSkillIds !== undefined) out.recommendedSkillIds = safeSemanticIdList(value.recommendedSkillIds, "playbook recommendedSkillId", 16);
    return out;
}

function safeCoworkerIds(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 8)
        throw new Error("team coworker roster must contain 2 to 8 coworkers");
    const ids = [...new Set(value.map((entry) => safeId(entry, "coworkerId")))];
    if (ids.length < 2) throw new Error("team coworker roster must contain 2 to 8 unique coworkers");
    return ids;
}

function safePlaybooks(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).map((entry) => ({
        id: safeId(entry.id, "playbookId"),
        name: safeString(entry.name, "playbook name", 120),
        description: safeString(entry.description ?? "", "playbook description", 500),
        steps: Array.isArray(entry.steps) ? entry.steps.slice(0, 12).map((step) => safeId(step, "playbook step")) : [],
        ...safePlaybookSemantics(entry),
    }));
}

function collaborationId(value, label, prefix) {
    const pattern = prefix ? new RegExp(`^${prefix}_[a-f0-9]{16}$`, "i") : COLLABORATION_ID;
    if (typeof value !== "string" || !pattern.test(value))
        throw new Error(`${label} must be a collaboration identifier`);
    return value;
}

function safeLedgerText(value, label, max = 240) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length > max) throw new Error(`${label} must be bounded text`);
    const text = value.trim();
    if (!text) return undefined;
    // Product-facing reasons are intentionally path/session neutral.  The runtime
    // remains the authority for detailed diagnostics; the ledger stores only safe
    // collaboration context.
    return text
        .replace(/[A-Za-z]:[\\/][^\s]+|(?:^|\s)\\\\[^\s]+/g, "[private detail]")
        .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s]*/g, " [private detail]")
        .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [private detail]")
        .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/gi, "[private detail]")
        .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s]+/gi, "[private detail]")
        .replace(/\b(?:run|request|operation|event|token|protocolRequest|runtime|audit|session)_[A-Za-z0-9._:-]+\b/gi, "[private detail]");
}

function safeActiveProtocol(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    try {
        const protocolRequestId = collaborationId(value.protocolRequestId, "protocolRequestId", "request");
        const kind = value.kind;
        const protocolState = value.state;
        if (!PROTOCOL_KINDS.has(kind) || !PROTOCOL_STATES.has(protocolState)) return undefined;
        const sourceCoworkerId = safeId(value.sourceCoworkerId, "protocol sourceCoworkerId");
        const targetCoworkerId = safeId(value.targetCoworkerId, "protocol targetCoworkerId");
        const revision = Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= MAX_PROTOCOL_REVISIONS
            ? value.revision : 0;
        const boundedTask = safeLedgerText(value.boundedTask, "boundedTask", 800);
        const reason = safeLedgerText(value.reason, "reason", 400);
        const candidateArtifactIds = Array.isArray(value.candidateArtifactIds)
            ? value.candidateArtifactIds.slice(0, 12).map((id) => safeId(id, "candidate artifactId"))
            : [];
        return {
            protocolRequestId,
            kind,
            state: protocolState,
            sourceCoworkerId,
            targetCoworkerId,
            ...(value.reviewerCoworkerId ? { reviewerCoworkerId: safeId(value.reviewerCoworkerId, "reviewerCoworkerId") } : {}),
            revision,
            ...(boundedTask ? { boundedTask } : {}),
            ...(reason ? { reason } : {}),
            candidateArtifactIds,
        };
    }
    catch { return undefined; }
}

function publicActiveProtocol(value, coworkerName = (id) => id) {
    const protocol = safeActiveProtocol(value);
    if (!protocol) return undefined;
    return {
        kind: protocol.kind,
        state: protocol.state,
        revision: protocol.revision,
        sourceCoworkerId: protocol.sourceCoworkerId,
        sourceCoworker: coworkerName(protocol.sourceCoworkerId),
        targetCoworkerId: protocol.targetCoworkerId,
        targetCoworker: coworkerName(protocol.targetCoworkerId),
        ...(protocol.reviewerCoworkerId ? { reviewerCoworkerId: protocol.reviewerCoworkerId, reviewerCoworker: coworkerName(protocol.reviewerCoworkerId) } : {}),
        ...(protocol.boundedTask ? { boundedTask: protocol.boundedTask } : {}),
        ...(protocol.reason ? { reason: protocol.reason } : {}),
        ...(protocol.candidateArtifactIds.length ? { artifactIds: [...protocol.candidateArtifactIds] } : {}),
    };
}

function safeActiveFanout(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    try {
        const fanoutId = collaborationId(value.fanoutId, "fanoutId", "request");
        const state = value.state;
        if (!FANOUT_STATES.has(state)) return undefined;
        const ownerCoworkerId = safeId(value.ownerCoworkerId, "fanout ownerCoworkerId");
        const reviewerCoworkerId = safeId(value.reviewerCoworkerId, "fanout reviewerCoworkerId");
        if (!Array.isArray(value.children) || value.children.length < 2 || value.children.length > MAX_FANOUT_CHILDREN) return undefined;
        const keys = new Set();
        const coworkerIds = new Set();
        const children = value.children.map((child) => {
            if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("invalid fanout child");
            const key = safeId(child.key, "fanout child key", /^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
            if (keys.has(key)) throw new Error("duplicate fanout child key");
            const coworkerId = safeId(child.coworkerId, "fanout child coworkerId");
            if (coworkerIds.has(coworkerId)) throw new Error("duplicate fanout child coworker");
            keys.add(key); coworkerIds.add(coworkerId);
            const childId = collaborationId(child.childId, "fanout childId", "operation");
            const childState = FANOUT_CHILD_STATES.has(child.state) ? child.state : "requested";
            return {
                childId,
                key,
                coworkerId,
                task: safeLedgerText(child.task, "fanout child task", 800) ?? "Bounded specialist task",
                ...(child.requiresComputer === true ? { requiresComputer: true } : {}),
                workspaceKey: safeId(child.workspaceKey, "fanout workspaceKey", /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/),
                state: childState,
                ...(child.messageId ? { messageId: safeId(child.messageId, "fanout child messageId") } : {}),
                ...(child.taskId ? { taskId: safeId(child.taskId, "fanout child taskId") } : {}),
                ...(Array.isArray(child.artifactIds) ? { artifactIds: child.artifactIds.slice(0, 12).map((id) => safeId(id, "fanout artifactId")) } : {}),
                ...(child.resultText ? { resultText: safeLedgerText(child.resultText, "fanout child result", MAX_FANOUT_TEXT) } : {}),
                ...(typeof child.updatedAt === "string" ? { updatedAt: child.updatedAt } : {}),
            };
        });
        if (coworkerIds.has(ownerCoworkerId) || coworkerIds.has(reviewerCoworkerId) || ownerCoworkerId === reviewerCoworkerId) return undefined;
        return {
            fanoutId,
            state,
            ownerCoworkerId,
            reviewerCoworkerId,
            children,
            ...(value.sourceMessageId ? { sourceMessageId: safeId(value.sourceMessageId, "fanout sourceMessageId") } : {}),
            ...(value.ownerMessageId ? { ownerMessageId: safeId(value.ownerMessageId, "fanout ownerMessageId") } : {}),
            ...(value.reviewMessageId ? { reviewMessageId: safeId(value.reviewMessageId, "fanout reviewMessageId") } : {}),
            ...(value.joinMessageId ? { joinMessageId: safeId(value.joinMessageId, "fanout joinMessageId") } : {}),
            revision: Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= MAX_PROTOCOL_REVISIONS ? value.revision : 0,
            ...(value.reviewDecision ? { reviewDecision: ["approved", "changes-requested"].includes(value.reviewDecision) ? value.reviewDecision : undefined } : {}),
            ...(value.reviewText ? { reviewText: safeLedgerText(value.reviewText, "fanout review", MAX_FANOUT_TEXT) } : {}),
            ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
            ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
        };
    }
    catch { return undefined; }
}

function publicActiveFanout(value, coworkerName = (id) => id) {
    const fanout = safeActiveFanout(value);
    if (!fanout) return undefined;
    return {
        state: fanout.state,
        owner: coworkerName(fanout.ownerCoworkerId),
        reviewer: coworkerName(fanout.reviewerCoworkerId),
        revision: fanout.revision,
        children: fanout.children.map((child) => ({
            key: child.key,
            coworker: coworkerName(child.coworkerId),
            task: child.task,
            status: child.state,
            artifactCount: child.artifactIds?.length ?? 0,
            ...(child.resultText ? { resultSummary: child.resultText } : {}),
        })),
        review: fanout.reviewDecision ?? (fanout.state === "review_requested" || fanout.state === "reviewing" ? "pending" : undefined),
        ...(fanout.reviewText ? { reviewSummary: fanout.reviewText } : {}),
        joinReady: fanout.state === "join_requested" || fanout.state === "joining",
    };
}

function sanitizeCollaboration(value, teamIds, conversationIds) {
    const result = { schema: COLLABORATION_SCHEMA, runs: [], events: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    const runs = Array.isArray(value.runs) ? value.runs : [];
    for (const entry of runs.slice(-MAX_COLLABORATION_RUNS)) {
        try {
            if (!entry || typeof entry !== "object") continue;
            const runId = collaborationId(entry.runId, "runId", "run");
            const requestId = collaborationId(entry.requestId, "requestId", "request");
            const operationId = collaborationId(entry.operationId, "operationId", "operation");
            const operationToken = entry.operationToken === undefined
                ? `token_${operationId.slice("operation_".length)}`
                : collaborationId(entry.operationToken, "operationToken", "token");
            if (!conversationIds.has(entry.conversationId) || !teamIds.has(entry.teamId)) continue;
            if (!COLLABORATION_STATUSES.has(entry.status) || !["chief", "coding-lead", "specialist", "reviewer", "synthesis", "complete"].includes(entry.stage)) continue;
            if (typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") continue;
            result.runs.push({ runId, teamId: entry.teamId, conversationId: entry.conversationId, requestId, operationId, operationToken, status: entry.status, stage: entry.stage, version: Number.isInteger(entry.version) && entry.version >= 0 ? entry.version : 0, ...(entry.ownerId ? { ownerId: safeId(entry.ownerId, "ownerId") } : {}), createdAt: entry.createdAt, updatedAt: entry.updatedAt });
        }
        catch {}
    }
    const runIds = new Set(result.runs.map((entry) => entry.runId));
    for (const entry of (Array.isArray(value.events) ? value.events : []).slice(-MAX_COLLABORATION_EVENTS)) {
        try {
            if (!entry || typeof entry !== "object") continue;
            const eventId = collaborationId(entry.eventId, "eventId", "event");
            const runId = collaborationId(entry.runId, "runId", "run");
            const requestId = collaborationId(entry.requestId, "requestId", "request");
            const operationId = collaborationId(entry.operationId, "operationId", "operation");
            if (!runIds.has(runId) || !conversationIds.has(entry.conversationId) || !COLLABORATION_EVENT_TYPES.has(entry.type)) continue;
            if (!COLLABORATION_STATUSES.has(entry.status) || typeof entry.createdAt !== "string") continue;
            const protocolRequestId = entry.protocolRequestId ? collaborationId(entry.protocolRequestId, "protocolRequestId", "request") : undefined;
            const protocolKind = entry.protocolKind && PROTOCOL_KINDS.has(entry.protocolKind) ? entry.protocolKind : undefined;
            const protocolState = entry.protocolState && PROTOCOL_STATES.has(entry.protocolState) ? entry.protocolState : undefined;
            const decision = entry.decision && ["approved", "changes-requested"].includes(entry.decision) ? entry.decision : undefined;
            const revision = Number.isInteger(entry.revision) && entry.revision >= 0 && entry.revision <= MAX_PROTOCOL_REVISIONS ? entry.revision : undefined;
            const parentOperationId = entry.parentOperationId ? collaborationId(entry.parentOperationId, "parentOperationId", "operation") : undefined;
            const fanoutId = entry.fanoutId ? collaborationId(entry.fanoutId, "fanoutId", "request") : undefined;
            const childKey = entry.childKey ? safeId(entry.childKey, "childKey", /^[A-Za-z][A-Za-z0-9_-]{0,31}$/) : undefined;
            result.events.push({ eventId, runId, requestId, operationId, conversationId: entry.conversationId, type: entry.type, status: entry.status, ...(entry.actorId ? { actorId: safeId(entry.actorId, "actorId") } : {}), ...(entry.ownerId ? { ownerId: safeId(entry.ownerId, "ownerId") } : {}), ...(entry.targetCoworkerId ? { targetCoworkerId: safeId(entry.targetCoworkerId, "targetCoworkerId") } : {}), ...(entry.stage ? { stage: safeId(entry.stage, "stage") } : {}), ...(entry.messageId ? { messageId: safeId(entry.messageId, "messageId") } : {}), ...(Array.isArray(entry.artifactIds) ? { artifactIds: entry.artifactIds.slice(0, 12).map((id) => safeId(id, "artifactId")) } : {}), ...(protocolRequestId ? { protocolRequestId } : {}), ...(protocolKind ? { protocolKind } : {}), ...(protocolState ? { protocolState } : {}), ...(decision ? { decision } : {}), ...(revision !== undefined ? { revision } : {}), ...(parentOperationId ? { parentOperationId } : {}), ...(fanoutId ? { fanoutId } : {}), ...(childKey ? { childKey } : {}), ...(entry.reason ? { reason: safeLedgerText(entry.reason, "reason") } : {}), ...(entry.idempotencyKey ? { idempotencyKey: safeLedgerText(entry.idempotencyKey, "idempotencyKey", 160) } : {}), createdAt: entry.createdAt });
        }
        catch {}
    }
    return result;
}

function safePlaybookDefinition(value, { requireSchema = false } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("playbook must be an object");
    const allowed = new Set(["schema", "id", "name", "description", "steps", "stages", "reviewPoints", "expectedOutput", "recommendedCoworkerRoles", "recommendedSkillIds"]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`playbook field is not allowed: ${key}`);
    }
    if (requireSchema && value.schema !== TEAM_PLAYBOOK_EXPORT_SCHEMA)
        throw new Error(`playbook schema must be ${TEAM_PLAYBOOK_EXPORT_SCHEMA}`);
    if (!Array.isArray(value.steps) || value.steps.length > 12)
        throw new Error("playbook steps must be an array of at most 12 identifiers");
    const normalized = safePlaybooks([value])[0];
    if (!normalized) throw new Error("playbook is invalid");
    return { schema: TEAM_PLAYBOOK_EXPORT_SCHEMA, ...normalized };
}

function safePackModelBinding(value) {
    if (value === undefined || value === null) return { profile: "automatic" };
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("team pack modelBinding must be an object");
    const allowed = new Set(["profile", "provider", "model"]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`team pack modelBinding field is not allowed: ${key}`);
    }
    const profile = value.profile ?? "automatic";
    if (!["automatic", "efficient", "deep", "economy", "custom"].includes(profile))
        throw new Error("team pack modelBinding.profile is invalid");
    const provider = value.provider === undefined ? undefined : safeId(value.provider, "modelBinding.provider");
    if (provider && !["codex", "claude", "antigravity", "chatgpt-web", "economy"].includes(provider))
        throw new Error("team pack modelBinding.provider is invalid");
    const model = value.model === undefined ? undefined : safeId(value.model, "modelBinding.model");
    if (profile === "custom" && (!provider || !model))
        throw new Error("team pack custom modelBinding requires provider and model");
    return {
        profile,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
    };
}

function safePackDefinition(value, { requireSchema = false } = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("team pack must be an object");
    const allowed = new Set(["schema", "id", "name", "description", "coworkers", "channels", "playbooks"]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`team pack field is not allowed: ${key}`);
    }
    if (requireSchema && value.schema !== TEAM_PACK_EXPORT_SCHEMA)
        throw new Error(`team pack schema must be ${TEAM_PACK_EXPORT_SCHEMA}`);
    const id = safeId(value.id, "packId");
    const name = safeString(value.name, "team pack name", 120);
    const description = safeString(value.description, "team pack description", 500);
    if (!Array.isArray(value.coworkers) || value.coworkers.length < 2 || value.coworkers.length > 8)
        throw new Error("team pack must contain 2 to 8 coworkers");
    const keys = new Set();
    const coworkers = value.coworkers.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("team pack coworker must be an object");
        const coworkerAllowed = new Set(["key", "name", "role", "instructions", "avatar", "modelBinding"]);
        for (const key of Object.keys(entry)) {
            if (!coworkerAllowed.has(key)) throw new Error(`team pack coworker field is not allowed: ${key}`);
        }
        const key = safeId(entry.key, "team pack coworker key");
        if (keys.has(key)) throw new Error(`duplicate team pack coworker key: ${key}`);
        keys.add(key);
        return {
            key,
            name: safeString(entry.name, "team pack coworker name", 80),
            role: safeString(entry.role, "team pack coworker role", 120),
            instructions: safeString(entry.instructions, "team pack coworker instructions", 12_000),
            ...(entry.avatar === undefined ? {} : { avatar: safeString(entry.avatar, "team pack coworker avatar", 120) }),
            modelBinding: safePackModelBinding(entry.modelBinding),
        };
    });
    if (!Array.isArray(value.channels) || value.channels.length < 1 || value.channels.length > 8)
        throw new Error("team pack must contain 1 to 8 channels");
    const channelKeys = new Set();
    const channels = value.channels.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("team pack channel must be an object");
        const channelAllowed = new Set(["key", "name", "kind", "instructions", "playbookId"]);
        for (const key of Object.keys(entry)) {
            if (!channelAllowed.has(key)) throw new Error(`team pack channel field is not allowed: ${key}`);
        }
        const key = safeId(entry.key, "team pack channel key");
        if (channelKeys.has(key)) throw new Error(`duplicate team pack channel key: ${key}`);
        channelKeys.add(key);
        const kind = entry.kind ?? "project";
        if (!["work", "personal", "project"].includes(kind)) throw new Error("team pack channel kind is invalid");
        return {
            key,
            name: safeString(entry.name, "team pack channel name", 120),
            kind,
            instructions: safeString(entry.instructions, "team pack channel instructions", 12_000),
            playbookId: safeId(entry.playbookId, "team pack channel playbookId"),
        };
    });
    const playbooks = safePlaybooks(value.playbooks);
    if (!playbooks.length) throw new Error("team pack must contain at least one playbook");
    const playbookIds = new Set(playbooks.map((playbook) => playbook.id));
    for (const channel of channels) {
        if (!playbookIds.has(channel.playbookId)) throw new Error(`team pack channel references unknown playbook: ${channel.playbookId}`);
    }
    for (const playbook of playbooks) {
        for (const step of playbook.steps) {
            if (!keys.has(step)) throw new Error(`team pack playbook references unknown coworker: ${step}`);
        }
    }
    return {
        schema: TEAM_PACK_EXPORT_SCHEMA,
        id,
        name,
        description,
        coworkers,
        channels,
        playbooks,
    };
}

function exportablePack(pack) {
    return {
        schema: TEAM_PACK_EXPORT_SCHEMA,
        id: pack.id,
        name: pack.name,
        description: pack.description,
        coworkers: pack.coworkers.map((entry) => ({
            key: entry.key,
            name: entry.name,
            role: entry.role,
            instructions: entry.instructions,
            ...(entry.avatar ? { avatar: entry.avatar } : {}),
            modelBinding: safePackModelBinding(entry.modelBinding),
        })),
        channels: pack.channels.map((entry) => ({
            key: entry.key,
            name: entry.name,
            kind: entry.kind,
            instructions: entry.instructions,
            playbookId: entry.playbookId,
        })),
        playbooks: safePlaybooks(pack.playbooks),
    };
}

function sanitizePersisted(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== TEAMS_SCHEMA)
        return { teams: [], channels: [], flows: {}, collaboration: { schema: COLLABORATION_SCHEMA, runs: [], events: [] } };
    const channels = Array.isArray(value.channels) ? value.channels.map((entry) => {
        try {
            if (!entry || !CHANNEL_ID.test(entry.id) || !TEAM_ID.test(entry.teamId)) return undefined;
            return {
                id: entry.id,
                teamId: entry.teamId,
                kind: ["work", "personal", "project"].includes(entry.kind) ? entry.kind : "project",
                name: safeString(entry.name, "channel name", 120),
                instructions: safeString(entry.instructions ?? "", "channel instructions", 12_000),
                ...(entry.templateId === undefined ? {} : { templateId: safeId(entry.templateId, "channel templateId") }),
                coworkerIds: safeCoworkerIds(entry.coworkerIds),
                workspaceId: safeId(entry.workspaceId, "workspaceId"),
                conversationId: safeId(entry.conversationId, "conversationId"),
                playbookId: safeId(entry.playbookId, "playbookId"),
                archived: entry.archived === true,
                createdAt: safeString(entry.createdAt, "channel createdAt", 80),
                updatedAt: safeString(entry.updatedAt, "channel updatedAt", 80),
            };
        }
        catch { return undefined; }
    }).filter(Boolean).slice(0, MAX_CHANNELS) : [];
    const channelIds = new Set(channels.map((entry) => entry.id));
    const teams = Array.isArray(value.teams) ? value.teams.map((entry) => {
        try {
            if (!entry || !TEAM_ID.test(entry.id)) return undefined;
            const ids = safeCoworkerIds(entry.coworkerIds);
            const validChannels = Array.isArray(entry.channelIds) ? entry.channelIds.filter((id) => channelIds.has(id)).slice(0, 16) : [];
            return {
                id: entry.id,
                packId: safeId(entry.packId, "packId"),
                name: safeString(entry.name, "team name", 120),
                coworkerIds: ids,
                sharedWorkspaceId: safeId(entry.sharedWorkspaceId, "sharedWorkspaceId"),
                channelIds: validChannels,
                playbooks: safePlaybooks(entry.playbooks),
                coworkerKeyById: entry.coworkerKeyById && typeof entry.coworkerKeyById === "object" && !Array.isArray(entry.coworkerKeyById)
                    ? Object.fromEntries(Object.entries(entry.coworkerKeyById).filter(([id, key]) => ids.includes(id) && typeof key === "string").slice(0, 8))
                    : undefined,
                createdAt: safeString(entry.createdAt, "team createdAt", 80),
                updatedAt: safeString(entry.updatedAt, "team updatedAt", 80),
            };
        }
        catch { return undefined; }
    }).filter(Boolean).slice(0, MAX_TEAMS) : [];
    const teamIds = new Set(teams.map((entry) => entry.id));
    const filteredChannels = channels.filter((entry) => teamIds.has(entry.teamId));
    const flows = {};
    if (value.flows && typeof value.flows === "object" && !Array.isArray(value.flows)) {
        for (const [teamId, flow] of Object.entries(value.flows)) {
            if (!teamIds.has(teamId) || !flow || typeof flow !== "object") continue;
            const stage = ["chief", "coding-lead", "specialist", "reviewer", "synthesis", "complete"].includes(flow.stage) ? flow.stage : "complete";
            const routingDecision = flow.routingDecision && typeof flow.routingDecision === "object"
                && typeof flow.routingDecision.targetCoworkerId === "string"
                && typeof flow.routingDecision.reason === "string"
                && flow.routingDecision.handoffType === "delegate"
                && typeof flow.routingDecision.boundedTask === "string"
                ? {
                    targetCoworkerId: flow.routingDecision.targetCoworkerId.slice(0, 160),
                    reason: flow.routingDecision.reason.slice(0, 240),
                    handoffType: "delegate",
                    boundedTask: flow.routingDecision.boundedTask.slice(0, 1_000),
                }
                : undefined;
            const activeProtocol = safeActiveProtocol(flow.activeProtocol);
            const activeFanout = safeActiveFanout(flow.activeFanout);
            flows[teamId] = {
                stage,
                ...(Number.isInteger(flow.handoffIndex) && flow.handoffIndex >= 0 && flow.handoffIndex <= 16 ? { handoffIndex: flow.handoffIndex } : {}),
                ...(typeof flow.userMessageId === "string" ? { userMessageId: flow.userMessageId } : {}),
                ...(typeof flow.lastHandoffSourceId === "string" ? { lastHandoffSourceId: flow.lastHandoffSourceId } : {}),
                ...(typeof flow.lastHandoffTargetId === "string" ? { lastHandoffTargetId: flow.lastHandoffTargetId } : {}),
                ...(routingDecision ? { routingDecision } : {}),
                ...(typeof flow.runId === "string" && /^run_[a-f0-9]{16}$/i.test(flow.runId) ? { runId: flow.runId } : {}),
                ...(typeof flow.requestId === "string" && /^request_[a-f0-9]{16}$/i.test(flow.requestId) ? { requestId: flow.requestId } : {}),
                ...(typeof flow.operationId === "string" && /^operation_[a-f0-9]{16}$/i.test(flow.operationId) ? { operationId: flow.operationId } : {}),
                ...(typeof flow.operationToken === "string" && /^token_[a-f0-9]{16}$/i.test(flow.operationToken) ? { operationToken: flow.operationToken } : {}),
                ...(Number.isInteger(flow.version) && flow.version >= 0 && flow.version <= 1_000_000 ? { version: flow.version } : {}),
                ...(typeof flow.ownerId === "string" ? { ownerId: flow.ownerId.slice(0, 160) } : {}),
                ...(COLLABORATION_STATUSES.has(flow.runStatus) ? { runStatus: flow.runStatus } : {}),
                ...(typeof flow.attentionReason === "string" ? { attentionReason: safeLedgerText(flow.attentionReason, "attentionReason") } : {}),
                ...(Array.isArray(flow.attentionCoworkerIds) ? { attentionCoworkerIds: flow.attentionCoworkerIds.slice(0, 8).filter((id) => typeof id === "string").map((id) => id.slice(0, 160)) } : {}),
                ...(activeProtocol ? { activeProtocol } : {}),
                ...(activeFanout ? { activeFanout } : {}),
                ...(typeof flow.updatedAt === "string" ? { updatedAt: flow.updatedAt } : {}),
            };
        }
    }
    const conversationIds = new Set(filteredChannels.map((entry) => entry.conversationId));
    return { teams, channels: filteredChannels, flows, collaboration: sanitizeCollaboration(value.collaboration, teamIds, conversationIds) };
}

function publicChannel(channel) {
    return {
        id: channel.id,
        teamId: channel.teamId,
        kind: channel.kind,
        name: channel.name,
        instructions: channel.instructions,
        ...(channel.templateId ? { templateId: channel.templateId } : {}),
        coworkerIds: [...channel.coworkerIds],
        workspaceId: channel.workspaceId,
        conversationId: channel.conversationId,
        playbookId: channel.playbookId,
        archived: channel.archived === true,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
    };
}

export function createTeamService({ dataDir, persistPath = join(dataDir, "desktop-state", "teams.json"), coworkerStore, conversationStore, services, now = () => new Date().toISOString(), makeTeamId = () => idFactory("team"), makeChannelId = () => idFactory("channel") } = {}) {
    if (!dataDir || !coworkerStore?.list || !coworkerStore?.create || !conversationStore?.createTeam || !conversationStore?.get || !services?.createManagedWorkspace || !services?.workspacePath)
        throw new Error("team service requires dataDir, stores and managed workspace services");
    const loaded = sanitizePersisted(loadJsonState(persistPath, null));
    const state = { schema: TEAMS_SCHEMA, ...loaded };
    state.collaboration ??= { schema: COLLABORATION_SCHEMA, runs: [], events: [] };
    for (const flow of Object.values(state.flows)) {
        const run = state.collaboration.runs.find((entry) => entry.runId === flow.runId);
        if (!run) continue;
        flow.requestId ??= run.requestId;
        flow.operationId ??= run.operationId;
        flow.operationToken ??= run.operationToken;
        flow.ownerId ??= run.ownerId;
        flow.stage ??= run.stage;
        flow.version ??= run.version ?? 0;
    }
    let resolveCoworkerAppAccess;
    let runtimeHandoffPreflight;
    const runtimeProofs = new Map();

    function save() {
        saveJsonState(persistPath, state);
    }

    function requireTeam(teamId) {
        const team = state.teams.find((entry) => entry.id === String(teamId));
        if (!team) throw new Error(`unknown team id: ${teamId}`);
        return team;
    }

    function requireChannel(channelId) {
        const channel = state.channels.find((entry) => entry.id === String(channelId));
        if (!channel) throw new Error(`unknown channel id: ${channelId}`);
        return channel;
    }

    function coworkerName(id) {
        try { return coworkerStore.get(id)?.name ?? id; }
        catch { return id; }
    }

    function teamContextForConversation(conversationId) {
        const channel = state.channels.find((entry) => entry.conversationId === String(conversationId));
        if (!channel) return undefined;
        return { channel, team: requireTeam(channel.teamId) };
    }

    function runForConversation(conversationId) {
        const context = teamContextForConversation(conversationId);
        if (!context) return undefined;
        const flow = state.flows[context.team.id] ?? {};
        return state.collaboration.runs.find((entry) => entry.runId === flow.runId)
            ?? state.collaboration.runs.filter((entry) => entry.conversationId === String(conversationId)).at(-1);
    }

    function publicCollaborationEvent(event) {
        if (!event) return undefined;
        const ownerId = event.ownerId;
        const targetCoworkerId = event.targetCoworkerId;
        const productEvent = {
            "run.started": { kind: "working", label: "Working", status: "working" },
            "work.started": { kind: "working", label: "Working", status: "working" },
            "handoff.requested": { kind: "handoff", label: "Handoff requested", status: "working" },
            "handoff.accepted": { kind: "handoff-accepted", label: "Handoff accepted", status: "working" },
            "handoff.result": { kind: "submitted", label: "Submitted", status: "completed" },
            "review.requested": { kind: "review-requested", label: "Review requested", status: "working" },
            "review.accepted": { kind: "reviewing", label: "Reviewing", status: "working" },
            "review.submitted": { kind: "submitted", label: "Submitted", status: "completed" },
            "review.decision": event.status === "attention"
                ? { kind: "attention", label: "Attention", status: "attention" }
                : event.decision === "approved"
                    ? { kind: "approved", label: "Approved", status: "completed" }
                    : event.decision === "changes-requested"
                        ? { kind: "changes-requested", label: "Changes requested", status: "working" }
                        : { kind: "reviewing", label: "Reviewing", status: "working" },
            "work.completed": { kind: "submitted", label: "Submitted", status: "completed" },
            "run.completed": { kind: "completed", label: "Completed", status: "completed" },
            "work.failed": { kind: "attention", label: "Attention", status: "attention" },
            "handoff.blocked": { kind: "attention", label: "Attention", status: "attention" },
            "run.stopped": { kind: "attention", label: "Attention", status: "stopped" },
            "run.redirected": { kind: "working", label: "Working", status: "working" },
            "fanout.requested": { kind: "fanout", label: "Parallel work", status: "working" },
            "fanout.child.started": { kind: "fanout-child", label: "Specialist working", status: "working" },
            "fanout.child.submitted": { kind: "fanout-child", label: "Specialist submitted", status: "completed" },
            "fanout.review.requested": { kind: "review-requested", label: "Review requested", status: "working" },
            "fanout.review.started": { kind: "reviewing", label: "Reviewing", status: "working" },
            "fanout.reviewed": event.decision === "approved"
                ? { kind: "approved", label: "Approved", status: "completed" }
                : { kind: "attention", label: "Changes requested", status: "attention" },
            "fanout.join.requested": { kind: "joining", label: "Joining results", status: "working" },
            "fanout.joined": { kind: "completed", label: "Completed", status: "completed" },
            "fanout.blocked": { kind: "attention", label: "Attention", status: "attention" },
        }[event.type] ?? { kind: "activity", label: "Team activity", status: "working" };
        return {
            kind: productEvent.kind,
            label: productEvent.label,
            status: productEvent.status,
            conversationId: String(event.conversationId),
            ...(ownerId ? { owner: coworkerName(ownerId) } : {}),
            ...(targetCoworkerId ? { targetCoworker: coworkerName(targetCoworkerId) } : {}),
            ...(event.artifactIds?.length ? { artifactIds: [...event.artifactIds] } : {}),
            ...(event.revision !== undefined ? { revision: event.revision } : {}),
            ...(event.decision ? { decision: event.decision } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
            at: event.createdAt,
        };
    }

    function activityForConversation(conversationId, { limit = 24 } = {}) {
        const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 24));
        return state.collaboration.events
            .filter((entry) => entry.conversationId === String(conversationId))
            .slice(-safeLimit)
            .reverse()
            .map(publicCollaborationEvent);
    }

    function recordCollaborationEvent({ conversationId, type, status = "active", actorId, ownerId, targetCoworkerId, stage, messageId, artifactIds, reason, protocolRequestId, protocolKind, protocolState, revision, decision, parentOperationId, fanoutId, childKey, runId, requestId, operationId, operationToken, idempotencyKey, expectedVersion, flowPatch } = {}) {
        const context = teamContextForConversation(conversationId);
        if (!context) return undefined;
        if (!COLLABORATION_EVENT_TYPES.has(type)) throw new Error(`unknown collaboration event type: ${type}`);
        if (!COLLABORATION_STATUSES.has(status)) throw new Error(`unknown collaboration event status: ${status}`);
        const flow = state.flows[context.team.id] ?? {};
        if (idempotencyKey) {
            const existing = state.collaboration.events.find((entry) => entry.conversationId === String(conversationId) && entry.idempotencyKey === idempotencyKey);
            if (existing) return clone(existing);
        }
        const run = state.collaboration.runs.find((entry) => entry.runId === (runId ?? flow.runId)) ?? runForConversation(conversationId);
        if (!run) return undefined;
        const currentRunId = flow.runId ?? run.runId;
        const currentRequestId = flow.requestId ?? run.requestId;
        const currentOperationId = flow.operationId ?? run.operationId;
        const currentOperationToken = flow.operationToken ?? run.operationToken;
        if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion !== (flow.version ?? 0)))
            throw new Error("collaboration flow version is stale");
        if (runId !== undefined && runId !== currentRunId && !(type === "run.started" && flowPatch?.runId === runId)) throw new Error("collaboration run token is stale");
        if (requestId !== undefined && requestId !== flow.requestId && !(PROTOCOL_REQUEST_EVENTS.has(type) && flowPatch?.requestId === requestId)) throw new Error("collaboration request token is stale");
        if (operationId !== undefined && operationId !== flow.operationId && !(PROTOCOL_REQUEST_EVENTS.has(type) && flowPatch?.operationId === operationId)) throw new Error("collaboration operation token is stale");
        if (operationToken !== undefined && operationToken !== flow.operationToken && !(PROTOCOL_REQUEST_EVENTS.has(type) && flowPatch?.operationToken === operationToken)) throw new Error("collaboration operation proof is stale");
        for (const [id, label] of [[ownerId, "ownerId"], [targetCoworkerId, "targetCoworkerId"]]) {
            if (id !== undefined && !context.team.coworkerIds.includes(id))
                throw new Error(`${label} must be a member of the team`);
        }
        if (actorId !== undefined && !["user", "system"].includes(actorId) && !context.team.coworkerIds.includes(actorId))
            throw new Error("actorId must be a team member or system actor");
        const activeProtocol = flow.activeProtocol;
        if (["handoff.accepted", "review.accepted"].includes(type)) {
            const expectedAcceptanceState = type === "review.accepted" ? "review_accepted" : "accepted";
            const requestedState = type === "review.accepted" ? "review_requested" : "requested";
            if (!activeProtocol || activeProtocol.kind !== protocolKind || activeProtocol.state !== requestedState || actorId !== targetCoworkerId || ownerId !== targetCoworkerId || protocolState !== expectedAcceptanceState)
                throw new Error("protocol acceptance is not authorized");
        }
        if (PROTOCOL_REQUEST_EVENTS.has(type) && type !== "run.started" && ["requested", "review_requested"].includes(protocolState)) {
            const requestedProtocol = safeActiveProtocol(flowPatch?.activeProtocol);
            if (!requestedProtocol || requestedProtocol.state !== protocolState || requestedProtocol.targetCoworkerId !== targetCoworkerId || (ownerId !== activeProtocol?.sourceCoworkerId && ownerId !== actorId))
                throw new Error("protocol request is not authorized");
        }
        if (["handoff.result", "review.submitted"].includes(type)) {
            const workingState = protocolKind === "review" ? "reviewing" : "working";
            if (!activeProtocol || activeProtocol.kind !== protocolKind || activeProtocol.state !== workingState || actorId !== ownerId || ownerId !== activeProtocol.targetCoworkerId || protocolState !== "submitted")
                throw new Error("protocol result is not authorized");
        }
        if (type === "review.decision") {
            if (!activeProtocol || activeProtocol.kind !== "review" || activeProtocol.state !== "submitted" || actorId !== ownerId || ownerId !== activeProtocol.targetCoworkerId || !["approved", "changes-requested"].includes(decision))
                throw new Error("review decision is not authorized");
        }
        const event = {
            eventId: idFactory("event"),
            runId: run.runId,
            requestId: collaborationId(requestId ?? flow.requestId ?? run.requestId, "requestId"),
            operationId: collaborationId(operationId ?? flow.operationId ?? run.operationId, "operationId"),
            conversationId: String(conversationId),
            type,
            status,
            ...(actorId ? { actorId: safeId(actorId, "actorId") } : {}),
            ...(ownerId ? { ownerId: safeId(ownerId, "ownerId") } : {}),
            ...(targetCoworkerId ? { targetCoworkerId: safeId(targetCoworkerId, "targetCoworkerId") } : {}),
            ...(stage ? { stage: safeId(stage, "stage") } : {}),
            ...(messageId ? { messageId: safeId(messageId, "messageId") } : {}),
            ...(Array.isArray(artifactIds) && artifactIds.length ? { artifactIds: artifactIds.slice(0, 12).map((id) => safeId(id, "artifactId")) } : {}),
            ...(protocolRequestId ? { protocolRequestId: collaborationId(protocolRequestId, "protocolRequestId", "request") } : {}),
            ...(protocolKind ? { protocolKind: PROTOCOL_KINDS.has(protocolKind) ? protocolKind : (() => { throw new Error("protocolKind is invalid"); })() } : {}),
            ...(protocolState ? { protocolState: PROTOCOL_STATES.has(protocolState) ? protocolState : (() => { throw new Error("protocolState is invalid"); })() } : {}),
            ...(revision !== undefined ? { revision: Number.isInteger(revision) && revision >= 0 && revision <= MAX_PROTOCOL_REVISIONS ? revision : (() => { throw new Error("protocol revision is invalid"); })() } : {}),
            ...(decision ? { decision: ["approved", "changes-requested"].includes(decision) ? decision : (() => { throw new Error("review decision is invalid"); })() } : {}),
            ...(parentOperationId ? { parentOperationId: collaborationId(parentOperationId, "parentOperationId", "operation") } : {}),
            ...(fanoutId ? { fanoutId: collaborationId(fanoutId, "fanoutId", "request") } : {}),
            ...(childKey ? { childKey: safeId(childKey, "childKey", /^[A-Za-z][A-Za-z0-9_-]{0,31}$/) } : {}),
            ...(reason ? { reason: safeLedgerText(reason, "reason") } : {}),
            ...(idempotencyKey ? { idempotencyKey: safeLedgerText(idempotencyKey, "idempotencyKey", 160) } : {}),
            createdAt: now(),
        };
        state.collaboration.events.push(event);
        if (state.collaboration.events.length > MAX_COLLABORATION_EVENTS)
            state.collaboration.events.splice(0, state.collaboration.events.length - MAX_COLLABORATION_EVENTS);
        const nextFlow = { ...flow, ...(flowPatch ?? {}), version: (flow.version ?? 0) + 1 };
        if (Object.hasOwn(nextFlow, "activeProtocol")) {
            const normalizedProtocol = safeActiveProtocol(nextFlow.activeProtocol);
            if (nextFlow.activeProtocol !== undefined && !normalizedProtocol)
                throw new Error("active protocol is invalid");
            nextFlow.activeProtocol = normalizedProtocol;
        }
        if (Object.hasOwn(nextFlow, "activeFanout")) {
            const normalizedFanout = safeActiveFanout(nextFlow.activeFanout);
            if (nextFlow.activeFanout !== undefined && !normalizedFanout)
                throw new Error("active fanout is invalid");
            nextFlow.activeFanout = normalizedFanout;
        }
        if (["run.stopped", "run.redirected", "handoff.blocked"].includes(type) && nextFlow.activeProtocol)
            nextFlow.activeProtocol = { ...nextFlow.activeProtocol, state: type === "run.stopped" ? "stopped" : type === "run.redirected" ? "redirected" : "blocked" };
        if (["run.stopped", "run.redirected"].includes(type) && nextFlow.activeFanout)
            nextFlow.activeFanout = { ...nextFlow.activeFanout, state: type === "run.stopped" ? "stopped" : "redirected", updatedAt: event.createdAt };
        const runStatus = ["run.completed", "fanout.joined"].includes(type) ? "completed" : type === "run.stopped" ? "stopped" : ["work.failed", "handoff.blocked", "fanout.blocked"].includes(type) ? "attention" : status === "redirected" ? "redirected" : undefined;
        if (runStatus) {
            run.status = runStatus;
            nextFlow.runStatus = runStatus;
        }
        run.requestId = nextFlow.requestId ?? run.requestId;
        run.operationId = nextFlow.operationId ?? run.operationId;
        run.operationToken = nextFlow.operationToken ?? run.operationToken;
        run.ownerId = nextFlow.ownerId ?? run.ownerId;
        run.stage = nextFlow.stage ?? run.stage;
        run.version = nextFlow.version;
        run.updatedAt = event.createdAt;
        if (["work.failed", "handoff.blocked", "fanout.blocked"].includes(type)) {
            nextFlow.runStatus = "attention";
            nextFlow.attentionReason = event.reason ?? "Team work needs your attention.";
            if (targetCoworkerId && !flow.attentionCoworkerIds?.includes(targetCoworkerId))
                nextFlow.attentionCoworkerIds = [...(flow.attentionCoworkerIds ?? []), targetCoworkerId].slice(0, 8);
        }
        state.flows[context.team.id] = nextFlow;
        save();
        return clone(event);
    }

    function startRun({ conversationId, ownerId, stage, messageId }) {
        const context = teamContextForConversation(conversationId);
        if (!context) return undefined;
        const timestamp = now();
        const run = {
            runId: idFactory("run"),
            teamId: context.team.id,
            conversationId: String(conversationId),
            requestId: idFactory("request"),
            operationId: idFactory("operation"),
            operationToken: idFactory("token"),
            status: "active",
            stage,
            ownerId,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.collaboration.runs.push(run);
        if (state.collaboration.runs.length > MAX_COLLABORATION_RUNS)
            state.collaboration.runs.splice(0, state.collaboration.runs.length - MAX_COLLABORATION_RUNS);
        const flow = state.flows[context.team.id] ?? {};
        const flowPatch = {
            ...flow,
            runId: run.runId,
            requestId: run.requestId,
            operationId: run.operationId,
            operationToken: run.operationToken,
            ownerId,
            runStatus: "active",
            version: flow.version ?? 0,
            attentionCoworkerIds: [],
            attentionReason: undefined,
        };
        recordCollaborationEvent({ conversationId, type: "run.started", status: "active", actorId: "user", ownerId, stage, messageId, runId: run.runId, requestId: run.requestId, operationId: run.operationId, operationToken: run.operationToken, expectedVersion: flow.version ?? 0, flowPatch, idempotencyKey: `run.started:${messageId}` });
        return clone(run);
    }

    function claimStage({ conversationId, ownerId, messageId, idempotencyKey, expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken } = {}) {
        const context = teamContextForConversation(conversationId);
        if (!context) return undefined;
        if (!context.team.coworkerIds.includes(ownerId)) throw new Error("stage owner must be a team member");
        if (coworkerStore.get(ownerId).state !== "active") throw new Error("stage owner is not active");
        const flow = state.flows[context.team.id] ?? {};
        const run = runForConversation(conversationId);
        if (!run || flow.runStatus === "stopped") throw new Error("collaboration run is not active");
        const protocol = flow.activeProtocol;
        if (["requested", "review_requested"].includes(protocol?.state)) throw new Error("protocol request must be accepted before work starts");
        if (protocol && protocol.targetCoworkerId !== ownerId) throw new Error("protocol owner is not the designated target");
        const nextProtocol = protocol && ["accepted", "review_accepted"].includes(protocol.state)
            ? { ...protocol, state: protocol.kind === "review" ? "reviewing" : "working" }
            : undefined;
        if (flow.ownerId && flow.ownerId !== ownerId) throw new Error(`stage owner is already claimed by ${flow.ownerId}`);
        return publicCollaborationEvent(recordCollaborationEvent({ conversationId, type: "work.started", status: "active", actorId: ownerId, ownerId, stage: flow.stage, messageId, ...(protocol ? { protocolRequestId: protocol.protocolRequestId, protocolKind: protocol.kind, protocolState: protocol.kind === "review" ? "reviewing" : "working", revision: protocol.revision } : {}), runId: expectedRunId ?? run.runId, requestId: expectedRequestId ?? run.requestId, operationId: expectedOperationId ?? run.operationId, operationToken: expectedOperationToken ?? run.operationToken, expectedVersion: expectedVersion ?? (flow.version ?? 0), flowPatch: { ownerId, runStatus: "active", ...(nextProtocol ? { activeProtocol: nextProtocol } : {}) }, idempotencyKey: idempotencyKey ?? `work.started:${messageId}:${ownerId}` }));
    }

    function collaborationContextForConversation(conversationId) {
        const context = teamContextForConversation(conversationId);
        if (!context) return undefined;
        const flow = state.flows[context.team.id] ?? {};
        const run = runForConversation(conversationId);
        if (!run || !flow.runId) return undefined;
        return { runId: run.runId, requestId: flow.requestId ?? run.requestId, operationId: flow.operationId ?? run.operationId, operationToken: flow.operationToken ?? run.operationToken, version: flow.version ?? 0, stage: flow.stage, ownerId: flow.ownerId, ...(flow.activeProtocol ? { activeProtocol: clone(flow.activeProtocol) } : {}), ...(flow.activeFanout ? { activeFanout: clone(flow.activeFanout) } : {}) };
    }

    function fanoutContextForConversation(conversationId) {
        const context = collaborationContextForConversation(conversationId);
        if (!context?.activeFanout) return undefined;
        return context;
    }

    function requestFanout({ conversationId, ownerCoworkerId, sourceMessageId, reviewerCoworkerId, children = [], expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken } = {}) {
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("fanout conversation is not a managed team channel");
        const flow = state.flows[context.team.id] ?? {};
        const run = runForConversation(conversationId);
        if (!run || flow.runStatus === "stopped") throw new Error("collaboration run is not active");
        if (flow.ownerId !== ownerCoworkerId) throw new Error("only the current owner can start a fanout");
        if (flow.activeFanout) {
            if (flow.activeFanout.sourceMessageId === sourceMessageId) return clone(flow.activeFanout);
            throw new Error("a fanout is already active");
        }
        if (!Array.isArray(children) || children.length < 2 || children.length > MAX_FANOUT_CHILDREN) throw new Error("fanout requires 2 to 4 children");
        if (!context.team.coworkerIds.includes(ownerCoworkerId) || coworkerStore.get(ownerCoworkerId).state !== "active") throw new Error("fanout owner is not an active team member");
        if (!context.team.coworkerIds.includes(reviewerCoworkerId) || reviewerCoworkerId === ownerCoworkerId || coworkerStore.get(reviewerCoworkerId).state !== "active") throw new Error("fanout reviewer is not an active independent team member");
        const keys = new Set();
        const targets = new Set();
        const normalizedChildren = children.map((entry) => {
            const key = safeId(entry.key, "fanout child key", /^[A-Za-z][A-Za-z0-9_-]{0,31}$/);
            if (keys.has(key)) throw new Error("fanout child keys must be unique");
            const coworkerId = safeId(entry.coworkerId, "fanout child coworkerId");
            if (!context.team.coworkerIds.includes(coworkerId) || coworkerId === ownerCoworkerId || coworkerId === reviewerCoworkerId || coworkerStore.get(coworkerId).state !== "active") throw new Error("fanout child must be an active non-owner team member");
            if (targets.has(coworkerId)) throw new Error("fanout child coworkers must be unique");
            if (entry.requiresComputer === true && !(resolveCoworkerAppAccess?.(coworkerId)?.tools ?? []).includes("computer")) throw new Error("fanout child computer access is not assigned");
            keys.add(key); targets.add(coworkerId);
            return {
                childId: idFactory("operation"),
                key,
                coworkerId,
                task: safeLedgerText(entry.task, "fanout child task", 800) ?? "Bounded specialist task",
                ...(entry.requiresComputer === true ? { requiresComputer: true } : {}),
                workspaceKey: `fanout.${key}`,
                state: "requested",
                artifactIds: [],
            };
        });
        if (expectedVersion !== undefined && expectedVersion !== (flow.version ?? 0)) throw new Error("fanout flow version is stale");
        if (expectedRunId !== undefined && expectedRunId !== flow.runId) throw new Error("fanout run token is stale");
        if (expectedRequestId !== undefined && expectedRequestId !== flow.requestId) throw new Error("fanout request token is stale");
        if (expectedOperationId !== undefined && expectedOperationId !== flow.operationId) throw new Error("fanout operation token is stale");
        if (expectedOperationToken !== undefined && expectedOperationToken !== flow.operationToken) throw new Error("fanout operation proof is stale");
        const fanoutId = idFactory("request");
        const activeFanout = {
            fanoutId,
            state: "requested",
            ownerCoworkerId,
            reviewerCoworkerId,
            children: normalizedChildren,
            sourceMessageId: safeId(sourceMessageId, "fanout sourceMessageId"),
            revision: 0,
            createdAt: now(),
            updatedAt: now(),
        };
        recordCollaborationEvent({
            conversationId,
            type: "fanout.requested",
            status: "active",
            actorId: ownerCoworkerId,
            ownerId: ownerCoworkerId,
            targetCoworkerId: reviewerCoworkerId,
            messageId: sourceMessageId,
            fanoutId,
            runId: flow.runId,
            requestId: flow.requestId,
            operationId: flow.operationId,
            operationToken: flow.operationToken,
            expectedVersion: expectedVersion ?? (flow.version ?? 0),
            flowPatch: { activeFanout },
            idempotencyKey: `fanout.requested:${sourceMessageId}`,
        });
        return clone(activeFanout);
    }

    function requestParallelCollaboration({ conversationId, children = [], reviewerCoworkerId, reason } = {}) {
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("parallel collaboration requires a managed team channel");
        const { channel, team } = context;
        if (channel.archived) throw new Error("archived channel is read-only");
        const flow = state.flows[team.id] ?? {};
        const order = handoffOrder(team);
        const currentIndex = indexForFlow(flow, order);
        const ownerCoworkerId = flow.ownerId ?? (currentIndex === undefined ? undefined : order[currentIndex]);
        if (!ownerCoworkerId || flow.stage === "complete" || flow.runStatus !== "active" || !flow.runId)
            throw new Error("team channel has no active owner");
        if (!team.coworkerIds.includes(ownerCoworkerId) || coworkerStore.get(ownerCoworkerId).state !== "active")
            throw new Error("current owner is not an active team member");
        if (flow.activeFanout) throw new Error("parallel work is already active");
        const activeProtocol = safeActiveProtocol(flow.activeProtocol);
        const protocolBusy = activeProtocol && (new Set(["requested", "review_requested", "accepted", "review_accepted", "working", "reviewing"]).has(activeProtocol.state)
            || (activeProtocol.kind === "review" && activeProtocol.state === "submitted"));
        if (protocolBusy) throw new Error("parallel work is unavailable while collaboration is active");
        if (!Array.isArray(children) || children.length < 2 || children.length > MAX_FANOUT_CHILDREN)
            throw new Error("parallel collaboration requires 2 to 4 specialists");
        const safeReason = safeLedgerText(reason, "reason", 400);
        if (!safeReason) throw new Error("reason is required");
        const safeChildren = children.map((entry, index) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("parallel specialist must be an object");
            const targetCoworkerId = safeId(entry.targetCoworkerId, "targetCoworkerId");
            const boundedTask = safeLedgerText(entry.boundedTask, "boundedTask", 800);
            if (!boundedTask) throw new Error("boundedTask is required for every specialist");
            return {
                key: `specialist-${index + 1}`,
                coworkerId: targetCoworkerId,
                task: boundedTask,
                ...(entry.requiresComputer === true ? { requiresComputer: true } : {}),
            };
        });
        const targetIds = new Set(safeChildren.map((entry) => entry.coworkerId));
        if (targetIds.size !== safeChildren.length) throw new Error("parallel specialist targets must be unique");
        const reviewerId = safeId(reviewerCoworkerId, "reviewerCoworkerId");
        if (reviewerId === ownerCoworkerId || targetIds.has(reviewerId)) throw new Error("reviewer must be independent from the owner and specialists");
        const conversation = conversationStore.get(conversationId);
        const source = conversation.messages.at(-1);
        if (!source) throw new Error("parallel collaboration requires an existing conversation message");
        const current = collaborationContextForConversation(conversationId);
        const fanout = requestFanout({
            conversationId,
            ownerCoworkerId,
            sourceMessageId: source.id,
            reviewerCoworkerId: reviewerId,
            children: safeChildren,
            expectedVersion: current?.version,
            expectedRunId: current?.runId,
            expectedRequestId: current?.requestId,
            expectedOperationId: current?.operationId,
            expectedOperationToken: current?.operationToken,
        });
        let message;
        try {
            message = conversationStore.postCoworkerMessage(conversationId, ownerCoworkerId, {
                text: `Parallel specialists requested.\nReason: ${safeReason}`,
                replyTo: source.id,
                mentions: safeChildren.map((entry) => entry.coworkerId),
            }, { internal: true, notifyChannelUnread: false });
            bindFanoutMessage({ conversationId, kind: "owner", messageId: message.id, expectedFanoutId: fanout.fanoutId });
            conversationStore.markDelivery(conversationId, source.id, ownerCoworkerId, "delivered");
        }
        catch (error) {
            if (message) {
                try { conversationStore.markDelivery(conversationId, message.id, ownerCoworkerId, "failed", "The parallel request could not be committed safely."); } catch {}
            }
            try { blockFanout({ conversationId, coworkerId: ownerCoworkerId, reason: "The parallel request could not be published safely." }); } catch {}
            throw error;
        }
        const publicFanout = publicActiveFanout(state.flows[team.id]?.activeFanout, coworkerName);
        return {
            reviewerCoworkerId: reviewerId,
            childCoworkerIds: safeChildren.map((entry) => entry.coworkerId),
            fanout: publicFanout,
            message,
            team: publicTeam(team),
            activity: activityForConversation(conversationId, { limit: 24 }),
        };
    }

    function updateFanout(conversationId, mutate, event = {}) {
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("fanout conversation is not a managed team channel");
        const flow = state.flows[context.team.id] ?? {};
        const fanout = safeActiveFanout(flow.activeFanout);
        if (!fanout) throw new Error("fanout is not active");
        const next = mutate(clone(fanout), flow, context.team);
        const normalized = safeActiveFanout(next);
        if (!normalized) throw new Error("fanout update is invalid");
        if (event.type) {
            recordCollaborationEvent({
                conversationId,
                type: event.type,
                status: event.status ?? "active",
                actorId: event.actorId,
                ownerId: event.ownerId ?? normalized.ownerCoworkerId,
                targetCoworkerId: event.targetCoworkerId,
                messageId: event.messageId,
                artifactIds: event.artifactIds,
                reason: event.reason,
                decision: event.decision,
                fanoutId: normalized.fanoutId,
                childKey: event.childKey,
                runId: context.runId,
                requestId: context.requestId,
                operationId: context.operationId,
                operationToken: context.operationToken,
                expectedVersion: flow.version ?? 0,
                flowPatch: { ...(event.flowPatch ?? {}), activeFanout: normalized },
                idempotencyKey: event.idempotencyKey,
            });
            return clone(normalized);
        }
        state.flows[context.team.id] = { ...flow, activeFanout: normalized, version: (flow.version ?? 0) + 1, updatedAt: now() };
        const run = runForConversation(conversationId);
        if (run) { run.version = state.flows[context.team.id].version; run.updatedAt = state.flows[context.team.id].updatedAt; }
        save();
        return clone(normalized);
    }

    function bindFanoutMessage({ conversationId, kind, messageId, expectedFanoutId } = {}) {
        const value = safeId(messageId, "fanout messageId");
        return updateFanout(conversationId, (fanout) => {
            if (expectedFanoutId && fanout.fanoutId !== expectedFanoutId) throw new Error("fanout identity is stale");
            if (kind === "owner") {
                if (fanout.ownerMessageId && fanout.ownerMessageId !== value) throw new Error("fanout owner message is already bound");
                fanout.ownerMessageId = value;
                fanout.children = fanout.children.map((child) => ({ ...child, messageId: value }));
            }
            else if (kind === "review") {
                if (fanout.reviewMessageId && fanout.reviewMessageId !== value) throw new Error("fanout review message is already bound");
                fanout.reviewMessageId = value;
            }
            else if (kind === "join") {
                if (fanout.joinMessageId && fanout.joinMessageId !== value) throw new Error("fanout join message is already bound");
                fanout.joinMessageId = value;
            }
            else throw new Error("fanout message kind is invalid");
            return fanout;
        });
    }

    function fanoutChildForDelivery({ conversationId, messageId, coworkerId } = {}) {
        const context = fanoutContextForConversation(conversationId);
        const child = context?.activeFanout?.children.find((entry) => entry.coworkerId === coworkerId && entry.messageId === messageId);
        return child ? { ...context, fanout: clone(context.activeFanout), child: clone(child) } : undefined;
    }

    function fanoutReviewForDelivery({ conversationId, messageId, coworkerId } = {}) {
        const context = fanoutContextForConversation(conversationId);
        const fanout = context?.activeFanout;
        if (!fanout || fanout.reviewerCoworkerId !== coworkerId || !["review_requested", "reviewing"].includes(fanout.state)) return undefined;
        if (fanout.reviewMessageId && fanout.reviewMessageId !== messageId) return undefined;
        return { ...context, fanout: clone(fanout), review: true };
    }

    function fanoutJoinForDelivery({ conversationId, messageId, coworkerId } = {}) {
        const context = fanoutContextForConversation(conversationId);
        const fanout = context?.activeFanout;
        if (!fanout || fanout.ownerCoworkerId !== coworkerId || !["join_requested", "joining"].includes(fanout.state)) return undefined;
        if (fanout.joinMessageId && fanout.joinMessageId !== messageId) return undefined;
        return { ...context, fanout: clone(fanout), join: true };
    }

    function acceptFanoutChild({ conversationId, childKey, coworkerId, messageId, taskId, workspaceId } = {}) {
        return updateFanout(conversationId, (fanout, flow, team) => {
            const child = fanout.children.find((entry) => entry.key === childKey);
            if (!child || child.coworkerId !== coworkerId || child.messageId !== messageId || (child.state !== "requested" && !(child.state === "running" && child.taskId === taskId))) throw new Error("fanout child acceptance is stale");
            if (child.state === "running") return fanout;
            if (!team.coworkerIds.includes(coworkerId) || coworkerStore.get(coworkerId).state !== "active") throw new Error("fanout child is not active");
            if (workspaceId !== channelForConversation(conversationId)?.workspaceId || !services.workspacePath(workspaceId)) throw new Error("fanout child workspace is not trusted");
            child.state = "running";
            if (taskId) child.taskId = safeId(taskId, "fanout child taskId");
            fanout.state = "running";
            fanout.updatedAt = now();
            return fanout;
        }, { type: "fanout.child.started", actorId: coworkerId, ownerId: fanoutContextForConversation(conversationId)?.activeFanout?.ownerCoworkerId, targetCoworkerId: coworkerId, messageId, childKey, idempotencyKey: `fanout.child.started:${childKey}:${taskId}` });
    }

    function completeFanoutChild({ conversationId, childKey, coworkerId, taskId, artifactIds = [], resultText } = {}) {
        return updateFanout(conversationId, (fanout) => {
            const child = fanout.children.find((entry) => entry.key === childKey);
            if (!child || child.coworkerId !== coworkerId || child.state !== "running" || child.taskId !== taskId) throw new Error("fanout child result is stale");
            child.state = "completed";
            child.artifactIds = Array.isArray(artifactIds) ? artifactIds.slice(0, 12).map((id) => safeId(id, "fanout artifactId")) : [];
            child.resultText = safeLedgerText(resultText, "fanout child result", MAX_FANOUT_TEXT);
            child.updatedAt = now();
            fanout.updatedAt = now();
            return fanout;
        }, { type: "fanout.child.submitted", actorId: coworkerId, ownerId: fanoutContextForConversation(conversationId)?.activeFanout?.ownerCoworkerId, targetCoworkerId: coworkerId, childKey, artifactIds, idempotencyKey: `fanout.child.submitted:${childKey}:${taskId}` });
    }

    function requestFanoutReview({ conversationId } = {}) {
        const fanout = fanoutContextForConversation(conversationId)?.activeFanout;
        if (!fanout) throw new Error("fanout is not active");
        if (!["running", "review_requested"].includes(fanout.state)) throw new Error("fanout is not ready for review");
        if (fanout.children.some((child) => child.state !== "completed")) throw new Error("fanout children are not complete");
        if (fanout.state === "review_requested") return clone(fanout);
        return updateFanout(conversationId, (next) => { next.state = "review_requested"; next.updatedAt = now(); return next; }, { type: "fanout.review.requested", actorId: fanout.ownerCoworkerId, ownerId: fanout.ownerCoworkerId, targetCoworkerId: fanout.reviewerCoworkerId, idempotencyKey: `fanout.review.requested:${fanout.fanoutId}` });
    }

    function acceptFanoutReview({ conversationId, coworkerId, messageId } = {}) {
        const fanout = fanoutReviewForDelivery({ conversationId, messageId, coworkerId })?.fanout;
        if (!fanout || !["review_requested", "reviewing"].includes(fanout.state)) throw new Error("fanout review acceptance is stale");
        if (fanout.state === "reviewing") return fanout;
        return updateFanout(conversationId, (next) => { next.state = "reviewing"; next.updatedAt = now(); return next; }, { type: "fanout.review.started", actorId: coworkerId, ownerId: fanout.ownerCoworkerId, targetCoworkerId: coworkerId, messageId, idempotencyKey: `fanout.review.started:${fanout.fanoutId}` });
    }

    function completeFanoutReview({ conversationId, coworkerId, decision, resultText } = {}) {
        const context = fanoutContextForConversation(conversationId);
        if (!context?.activeFanout || context.activeFanout.reviewerCoworkerId !== coworkerId || context.activeFanout.state !== "reviewing") throw new Error("fanout review result is stale");
        if (!["approved", "changes-requested"].includes(decision)) throw new Error("fanout review decision is invalid");
        return updateFanout(conversationId, (fanout) => { fanout.reviewDecision = decision; fanout.reviewText = safeLedgerText(resultText, "fanout review", MAX_FANOUT_TEXT); fanout.state = decision === "approved" ? "join_requested" : "blocked"; fanout.updatedAt = now(); return fanout; }, { type: "fanout.reviewed", status: decision === "approved" ? "completed" : "attention", actorId: coworkerId, ownerId: context.activeFanout.reviewerCoworkerId, targetCoworkerId: coworkerId, decision, reason: decision === "approved" ? undefined : "The independent review requested changes.", idempotencyKey: `fanout.reviewed:${context.activeFanout.fanoutId}:${decision}` });
    }

    function acceptFanoutJoin({ conversationId, coworkerId, messageId } = {}) {
        const context = fanoutJoinForDelivery({ conversationId, messageId, coworkerId });
        if (!context?.activeFanout || context.activeFanout.ownerCoworkerId !== coworkerId || !["join_requested", "joining"].includes(context.activeFanout.state)) throw new Error("fanout join acceptance is stale");
        if (context.activeFanout.state === "joining") return context.activeFanout;
        return updateFanout(conversationId, (fanout) => { fanout.state = "joining"; fanout.updatedAt = now(); return fanout; }, { type: "fanout.join.requested", actorId: context.activeFanout.ownerCoworkerId, ownerId: context.activeFanout.ownerCoworkerId, targetCoworkerId: coworkerId, messageId, idempotencyKey: `fanout.join.requested:${context.activeFanout.fanoutId}` });
    }

    function completeFanoutJoin({ conversationId, coworkerId, taskId, artifactIds = [], expectedFanoutId } = {}) {
        const context = fanoutContextForConversation(conversationId);
        const fanout = context?.activeFanout;
        if (!fanout || fanout.fanoutId !== expectedFanoutId || fanout.ownerCoworkerId !== coworkerId || fanout.state !== "joining" || fanout.children.some((child) => child.state !== "completed") || fanout.reviewDecision !== "approved") throw new Error("fanout join is stale or incomplete");
        const event = recordCollaborationEvent({ conversationId, type: "fanout.joined", status: "completed", actorId: coworkerId, ownerId: coworkerId, artifactIds, fanoutId: fanout.fanoutId, messageId: fanout.joinMessageId, runId: context.runId, requestId: context.requestId, operationId: context.operationId, operationToken: context.operationToken, expectedVersion: context.version, flowPatch: { stage: "complete", ownerId: undefined, runStatus: "completed", activeFanout: undefined }, idempotencyKey: `fanout.joined:${fanout.fanoutId}` });
        return { event: publicCollaborationEvent(event), completed: true, taskId };
    }

    function blockFanout({ conversationId, reason, coworkerId, childKey, taskId } = {}) {
        const context = fanoutContextForConversation(conversationId);
        if (!context?.activeFanout) return undefined;
        const event = recordCollaborationEvent({ conversationId, type: "fanout.blocked", status: "attention", actorId: coworkerId ?? context.ownerId, ownerId: context.activeFanout.ownerCoworkerId, targetCoworkerId: childKey ? context.activeFanout.children.find((child) => child.key === childKey)?.coworkerId : context.activeFanout.reviewerCoworkerId, childKey, taskId, fanoutId: context.activeFanout.fanoutId, reason, runId: context.runId, requestId: context.requestId, operationId: context.operationId, operationToken: context.operationToken, expectedVersion: context.version, flowPatch: { activeFanout: { ...context.activeFanout, state: "blocked", updatedAt: now() }, runStatus: "attention", attentionReason: reason }, idempotencyKey: `fanout.blocked:${context.activeFanout.fanoutId}:${childKey ?? "run"}` });
        return publicCollaborationEvent(event);
    }

    function fanoutWorkspaceForChild({ conversationId, childKey } = {}) {
        const fanout = fanoutContextForConversation(conversationId)?.activeFanout;
        const child = fanout?.children.find((entry) => entry.key === childKey);
        if (!child) throw new Error("unknown fanout child");
        return { workspaceId: channelForConversation(conversationId)?.workspaceId, workspaceKey: `${fanout.fanoutId}.${child.workspaceKey}` };
    }

    function fanoutJoinSummary(conversationId) {
        const fanout = fanoutContextForConversation(conversationId)?.activeFanout;
        if (!fanout) return undefined;
        return { ownerCoworkerId: fanout.ownerCoworkerId, reviewerCoworkerId: fanout.reviewerCoworkerId, fanoutId: fanout.fanoutId, children: fanout.children.map((child) => ({ key: child.key, coworkerId: child.coworkerId, task: child.task, resultText: child.resultText ?? "Completed.", artifactIds: [...(child.artifactIds ?? [])] })) };
    }

    function pendingProtocolProof(conversationId) {
        const protocol = collaborationContextForConversation(conversationId)?.activeProtocol;
        if (!protocol || !["requested", "review_requested"].includes(protocol.state)) return undefined;
        for (const proof of runtimeProofs.values()) {
            if (proof.conversationId === String(conversationId)
                && proof.targetCoworkerId === protocol.targetCoworkerId
                && proof.runId === collaborationContextForConversation(conversationId)?.runId
                && proof.requestId === collaborationContextForConversation(conversationId)?.requestId
                && proof.operationId === collaborationContextForConversation(conversationId)?.operationId
                && proof.operationToken === collaborationContextForConversation(conversationId)?.operationToken
                && proof.version === collaborationContextForConversation(conversationId)?.version)
                return { proofId: proof.proofId, targetCoworkerId: proof.targetCoworkerId, agentId: proof.agentId, workspaceId: proof.workspaceId };
        }
        const context = collaborationContextForConversation(conversationId);
        if (context && runtimeHandoffPreflight) {
            try {
                return authorizeHandoffTarget({
                    conversationId,
                    sourceCoworkerId: protocol.sourceCoworkerId,
                    targetCoworkerId: protocol.targetCoworkerId,
                    expectedVersion: context.version,
                    expectedRunId: context.runId,
                    expectedRequestId: context.requestId,
                    expectedOperationId: context.operationId,
                    expectedOperationToken: context.operationToken,
                });
            }
            catch { return undefined; }
        }
        return undefined;
    }

    function acceptProtocol({ conversationId, targetCoworkerId, proofId, messageId, expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken, idempotencyKey } = {}) {
        if (idempotencyKey) {
            const existing = state.collaboration.events.find((entry) => entry.conversationId === String(conversationId) && entry.idempotencyKey === idempotencyKey);
            if (existing) return publicCollaborationEvent(existing);
        }
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("protocol conversation is not a managed team channel");
        const flow = state.flows[context.team.id] ?? {};
        const protocol = flow.activeProtocol;
        const requestedState = protocol?.kind === "review" ? "review_requested" : "requested";
        const acceptedState = protocol?.kind === "review" ? "review_accepted" : "accepted";
        if (!protocol || protocol.state !== requestedState) throw new Error("protocol request is not awaiting acceptance");
        if (protocol.targetCoworkerId !== targetCoworkerId) throw new Error("protocol target changed before acceptance");
        if (!context.team.coworkerIds.includes(targetCoworkerId) || coworkerStore.get(targetCoworkerId).state !== "active")
            throw new Error("protocol target is not an active team member");
        const proof = proofId ? runtimeProofs.get(proofId) : undefined;
        if (!proof || proof.conversationId !== String(conversationId) || proof.targetCoworkerId !== targetCoworkerId
            || proof.runId !== flow.runId || proof.requestId !== flow.requestId || proof.operationId !== flow.operationId
            || proof.operationToken !== flow.operationToken || proof.version !== (flow.version ?? 0))
            throw new Error("trusted protocol acceptance proof is missing or stale");
        if (expectedVersion !== undefined && expectedVersion !== flow.version) throw new Error("protocol acceptance version is stale");
        if (expectedRunId !== undefined && expectedRunId !== flow.runId) throw new Error("protocol acceptance run token is stale");
        if (expectedRequestId !== undefined && expectedRequestId !== flow.requestId) throw new Error("protocol acceptance request token is stale");
        if (expectedOperationId !== undefined && expectedOperationId !== flow.operationId) throw new Error("protocol acceptance operation token is stale");
        if (expectedOperationToken !== undefined && expectedOperationToken !== flow.operationToken) throw new Error("protocol acceptance proof is stale");
        const eventType = protocol.kind === "review" ? "review.accepted" : "handoff.accepted";
        const event = recordCollaborationEvent({
            conversationId,
            type: eventType,
            status: "active",
            actorId: targetCoworkerId,
            ownerId: targetCoworkerId,
            targetCoworkerId,
            stage: flow.stage,
            messageId,
            protocolRequestId: protocol.protocolRequestId,
            protocolKind: protocol.kind,
            protocolState: acceptedState,
            revision: protocol.revision,
            runId: flow.runId,
            requestId: flow.requestId,
            operationId: flow.operationId,
            operationToken: flow.operationToken,
            expectedVersion: expectedVersion ?? flow.version ?? 0,
            flowPatch: { ownerId: targetCoworkerId, runStatus: "active", activeProtocol: { ...protocol, state: acceptedState } },
            idempotencyKey: idempotencyKey ?? `${eventType}:${protocol.protocolRequestId}`,
        });
        runtimeProofs.delete(proofId);
        return publicCollaborationEvent(event);
    }

    function submitProtocolResult({ conversationId, coworkerId, messageId, artifactIds = [], expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken, idempotencyKey } = {}) {
        if (idempotencyKey) {
            const existing = state.collaboration.events.find((entry) => entry.conversationId === String(conversationId) && entry.idempotencyKey === idempotencyKey);
            if (existing) return publicCollaborationEvent(existing);
        }
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("protocol conversation is not a managed team channel");
        const flow = state.flows[context.team.id] ?? {};
        const protocol = flow.activeProtocol;
        const workingState = protocol?.kind === "review" ? "reviewing" : "working";
        if (!protocol || protocol.state !== workingState) throw new Error("protocol is not accepting a result");
        if (flow.ownerId !== coworkerId || protocol.targetCoworkerId !== coworkerId) throw new Error("only the active protocol target can submit a result");
        const eventType = protocol.kind === "review" ? "review.submitted" : "handoff.result";
        return publicCollaborationEvent(recordCollaborationEvent({
            conversationId,
            type: eventType,
            status: "completed",
            actorId: coworkerId,
            ownerId: coworkerId,
            targetCoworkerId: coworkerId,
            stage: flow.stage,
            messageId,
            artifactIds,
            protocolRequestId: protocol.protocolRequestId,
            protocolKind: protocol.kind,
            protocolState: "submitted",
            revision: protocol.revision,
            runId: expectedRunId ?? flow.runId,
            requestId: expectedRequestId ?? flow.requestId,
            operationId: expectedOperationId ?? flow.operationId,
            operationToken: expectedOperationToken ?? flow.operationToken,
            expectedVersion: expectedVersion ?? flow.version ?? 0,
            flowPatch: { runStatus: "active", activeProtocol: { ...protocol, state: "submitted", candidateArtifactIds: (artifactIds.length ? artifactIds : protocol.candidateArtifactIds).slice(0, 12) } },
            idempotencyKey: idempotencyKey ?? `${eventType}:${messageId}`,
        }));
    }

    function recordReviewDecision({ conversationId, coworkerId, messageId, decision, artifactIds = [], expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken, idempotencyKey } = {}) {
        if (idempotencyKey) {
            const existing = state.collaboration.events.find((entry) => entry.conversationId === String(conversationId) && entry.idempotencyKey === idempotencyKey);
            if (existing) return publicCollaborationEvent(existing);
        }
        if (!["approved", "changes-requested"].includes(decision)) throw new Error("review decision must be approved or changes-requested");
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("review conversation is not a managed team channel");
        const flow = state.flows[context.team.id] ?? {};
        const protocol = flow.activeProtocol;
        if (!protocol || protocol.kind !== "review" || protocol.state !== "submitted") throw new Error("review is not accepting a decision");
        if (flow.ownerId !== coworkerId || protocol.targetCoworkerId !== coworkerId || protocol.sourceCoworkerId === coworkerId)
            throw new Error("only the designated reviewer can decide");
        const nextState = decision === "approved" ? "approved" : protocol.revision >= MAX_PROTOCOL_REVISIONS ? "blocked" : "changes_requested";
        const limited = nextState === "blocked";
        return publicCollaborationEvent(recordCollaborationEvent({
            conversationId,
            type: "review.decision",
            status: limited ? "attention" : "active",
            actorId: coworkerId,
            ownerId: coworkerId,
            targetCoworkerId: coworkerId,
            stage: flow.stage,
            messageId,
            artifactIds: artifactIds.length ? artifactIds : protocol.candidateArtifactIds,
            reason: limited ? "The review revision limit was reached." : undefined,
            protocolRequestId: protocol.protocolRequestId,
            protocolKind: "review",
            protocolState: nextState,
            revision: protocol.revision,
            decision,
            runId: expectedRunId ?? flow.runId,
            requestId: expectedRequestId ?? flow.requestId,
            operationId: expectedOperationId ?? flow.operationId,
            operationToken: expectedOperationToken ?? flow.operationToken,
            expectedVersion: expectedVersion ?? flow.version ?? 0,
            flowPatch: {
                runStatus: limited ? "attention" : "active",
                ...(limited ? { attentionReason: "The review revision limit was reached." } : {}),
                activeProtocol: { ...protocol, state: nextState, candidateArtifactIds: (artifactIds.length ? artifactIds : protocol.candidateArtifactIds).slice(0, 12) },
            },
            idempotencyKey: idempotencyKey ?? `review.decision:${protocol.protocolRequestId}:${protocol.revision}:${decision}`,
        }));
    }

    function stopRun(conversationId, reason = "Work stopped by the user.", expected = {}) {
        const run = runForConversation(conversationId);
        if (!run || ["completed", "stopped"].includes(run.status)) return undefined;
        const context = collaborationContextForConversation(conversationId);
        const expectedVersion = expected.expectedVersion ?? expected.version ?? context?.version ?? 0;
        const runId = expected.expectedRunId ?? expected.runId ?? context?.runId ?? run.runId;
        const requestId = expected.expectedRequestId ?? expected.requestId ?? context?.requestId ?? run.requestId;
        const operationId = expected.expectedOperationId ?? expected.operationId ?? context?.operationId ?? run.operationId;
        const operationToken = expected.expectedOperationToken ?? expected.operationToken ?? context?.operationToken ?? run.operationToken;
        return recordCollaborationEvent({ conversationId, type: "run.stopped", status: "stopped", actorId: "user", ownerId: run.ownerId, stage: run.stage, reason, runId, requestId, operationId, operationToken, expectedVersion, idempotencyKey: `run.stopped:${runId}` });
    }

    function setRuntimeHandoffPreflight(preflight) {
        if (preflight !== undefined && typeof preflight !== "function") throw new Error("runtime handoff preflight must be a function");
        runtimeHandoffPreflight = preflight;
    }

    function authorizeHandoffTarget({ conversationId, sourceCoworkerId, targetCoworkerId, expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken } = {}) {
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("handoff conversation is not a managed team channel");
        const flow = state.flows[context.team.id] ?? {};
        if (!runtimeHandoffPreflight) throw new Error("trusted runtime handoff preflight is unavailable");
        if (expectedVersion !== undefined && expectedVersion !== (flow.version ?? 0)) throw new Error("handoff flow version is stale");
        if (expectedRunId !== undefined && expectedRunId !== flow.runId) throw new Error("handoff run token is stale");
        if (expectedRequestId !== undefined && expectedRequestId !== flow.requestId) throw new Error("handoff request token is stale");
        if (expectedOperationId !== undefined && expectedOperationId !== flow.operationId) throw new Error("handoff operation token is stale");
        if (expectedOperationToken !== undefined && expectedOperationToken !== flow.operationToken) throw new Error("handoff operation proof is stale");
        if (!context.team.coworkerIds.includes(sourceCoworkerId) || !context.team.coworkerIds.includes(targetCoworkerId)) throw new Error("handoff participants must be team members");
        if (sourceCoworkerId === targetCoworkerId) throw new Error("protocol participants must be different");
        if (coworkerStore.get(targetCoworkerId).state !== "active") throw new Error("handoff target is not active");
        const runtime = runtimeHandoffPreflight({ conversationId: String(conversationId), sourceCoworkerId, targetCoworkerId, workspaceId: channelForConversation(conversationId)?.workspaceId });
        if (!runtime || runtime.targetCoworkerId !== targetCoworkerId || typeof runtime.agentId !== "string" || typeof runtime.workspaceId !== "string") throw new Error("trusted runtime handoff preflight was not accepted");
        const proofId = idFactory("token");
        const proof = { proofId, conversationId: String(conversationId), sourceCoworkerId, targetCoworkerId, runId: flow.runId, requestId: flow.requestId, operationId: flow.operationId, operationToken: flow.operationToken, version: flow.version ?? 0, agentId: runtime.agentId, workspaceId: runtime.workspaceId };
        runtimeProofs.set(proofId, proof);
        return { proofId, targetCoworkerId, agentId: runtime.agentId, workspaceId: runtime.workspaceId };
    }

    function handoffOrder(team) {
        const ids = [...team.coworkerIds];
        const declared = team.playbooks?.[0]?.steps?.map((key) => team.coworkerKeyById?.[key] ?? key);
        if (Array.isArray(declared) && declared.length >= 2 && declared.length <= 12 && declared.every((id) => ids.includes(id))) return [...declared];
        if (ids.length < 2) return ids;
        // The first teammate owns intake, the last is the reviewer, and any middle
        // teammates are bounded specialists.  This keeps Team Packs declarative and
        // lets ordinary user-created teams use the same one-owner handoff contract.
        return ids.length === 2
            ? [ids[0], ids[1], ids[0]]
            : [ids[0], ...ids.slice(1, -1), ids.at(-1), ids[0]];
    }

    function indexForFlow(flow, order) {
        if (Number.isInteger(flow.handoffIndex) && flow.handoffIndex >= 0 && flow.handoffIndex < order.length)
            return flow.handoffIndex;
        if (flow.stage === "chief") return 0;
        if (flow.stage === "synthesis") return Math.max(0, order.length - 1);
        if (flow.stage === "reviewer") return Math.max(0, order.length - 2);
        if (flow.stage === "coding-lead") return Math.min(1, Math.max(0, order.length - 1));
        return undefined;
    }

    function stageForIndex(index, order) {
        if (index === 0) return "chief";
        if (index === order.length - 1) return "synthesis";
        if (index === order.length - 2) return "reviewer";
        return index === 1 ? "coding-lead" : "specialist";
    }

    function flowStatus(team) {
        const flow = state.flows[team.id] ?? { stage: "complete" };
        const channel = state.channels.find((entry) => entry.teamId === team.id);
        const order = handoffOrder(team);
        const ownerIndex = indexForFlow(flow, order);
        const currentOwnerId = flow.stage === "complete" || ownerIndex === undefined ? undefined : order[ownerIndex];
        const conversation = channel ? conversationStore.get(channel.conversationId) : undefined;
        const pending = conversation
            ? Object.entries(conversation.messages.at(-1)?.delivery ?? {}).filter(([, value]) => value?.status === "pending").map(([id]) => id)
            : [];
        const attention = conversation
            ? [...new Set([
                ...(flow.attentionCoworkerIds ?? []),
                ...conversation.messages.flatMap((message) => Object.entries(message.delivery ?? {})
                .filter(([, value]) => value?.status === "failed")
                .map(([id]) => id)),
            ])]
            : [];
        const status = flow.runStatus === "stopped" ? "stopped"
            : flow.attentionReason || flow.runStatus === "attention" ? "needs-attention"
                : pending.length ? "active"
                    : flow.stage === "complete" || flow.runStatus === "completed" ? "available" : "waiting";
        const effectiveOwnerId = flow.stage === "complete" ? undefined : flow.ownerId ?? currentOwnerId;
        return {
            stage: flow.stage,
            status,
            currentOwnerId: effectiveOwnerId,
            currentOwner: effectiveOwnerId ? coworkerName(effectiveOwnerId) : undefined,
            pendingCoworkerIds: pending,
            attentionCoworkerIds: attention,
            channelId: channel?.id,
            ...(flow.attentionReason ? { attentionReason: flow.attentionReason } : {}),
            ...(conversation ? { activity: activityForConversation(conversation.id, { limit: 12 }) } : {}),
            ...(flow.activeProtocol ? { activeProtocol: publicActiveProtocol(flow.activeProtocol, coworkerName) } : {}),
            ...(flow.activeFanout ? { activeFanout: publicActiveFanout(flow.activeFanout, coworkerName) } : {}),
            ...(flow.routingDecision ? { routingDecision: clone(flow.routingDecision) } : {}),
        };
    }

    function routingCandidates(conversation, currentCoworkerId) {
        const pending = new Map();
        for (const message of conversation?.messages ?? []) {
            for (const [id, delivery] of Object.entries(message.delivery ?? [])) {
                if (delivery?.status === "pending") pending.set(id, (pending.get(id) ?? 0) + 1);
            }
        }
        return (conversation?.participants ?? [])
            .filter((id) => id !== "user" && id !== currentCoworkerId)
            .map((id) => {
                try {
                    const coworker = coworkerStore.get(id);
                    const access = resolveCoworkerAppAccess?.(id) ?? {};
                    return {
                        id: coworker.id,
                        name: coworker.name,
                        role: coworker.role,
                        instructions: coworker.instructions,
                        modelProfile: coworker.modelBinding?.profile,
                        appCapabilities: [
                            ...(access.capabilities ?? []),
                            ...(access.tools ?? []),
                            ...(access.appIds ?? []),
                        ],
                        state: coworker.state,
                        pendingCount: pending.get(id) ?? 0,
                    };
                }
                catch { return undefined; }
            })
            .filter(Boolean);
    }

    function publicTeam(team) {
        return {
            id: team.id,
            packId: team.packId,
            name: team.name,
            coworkerIds: [...team.coworkerIds],
            coworkers: team.coworkerIds.map((id) => ({ id, name: coworkerName(id) })),
            channelIds: [...team.channelIds],
            channels: team.channelIds
                .map((channelId) => state.channels.find((entry) => entry.id === channelId))
                .filter(Boolean)
                .map(publicChannel),
            sharedWorkspaceId: team.sharedWorkspaceId,
            sharedWorkspaceLabel: services.workspaceLabel?.(team.sharedWorkspaceId) ?? "Shared project workspace",
            privateWorkspaceLabel: "Private workspace",
            playbooks: clone(team.playbooks),
            flow: flowStatus(team),
            createdAt: team.createdAt,
            updatedAt: team.updatedAt,
        };
    }

    function findCoworkerByName(name) {
        return coworkerStore.list({ includeArchived: true }).coworkers.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    }

    function ensureCoworker(definition) {
        const existing = findCoworkerByName(definition.name);
        const coworkerId = existing
            ? (existing.state === "archived" ? coworkerStore.restore(existing.id).id : existing.id)
            : coworkerStore.create({
                name: definition.name,
                role: definition.role,
                instructions: definition.instructions,
                avatar: definition.avatar,
                modelBinding: definition.modelBinding,
            }).id;

        // Every installed teammate gets a durable private scratch.  The path is owned by
        // the trusted main-process workspace service; only its opaque id is kept on the
        // coworker record and exposed to the renderer.
        const current = coworkerStore.get(coworkerId);
        const privateHint = `${coworkerId}-private`;
        const privateWorkspace = services.createManagedWorkspace({
            label: `${definition.name} private scratch`,
            kind: "private-scratch",
            idHint: privateHint,
        });
        const privateWorkspaceId = privateWorkspace.workspace?.id;
        safeId(privateWorkspaceId, "privateWorkspaceId");
        const workspaceIds = [...(current.workspaceIds ?? [])];
        if (!workspaceIds.includes(privateWorkspaceId))
            coworkerStore.update(coworkerId, { workspaceIds: [privateWorkspaceId, ...workspaceIds] });
        return coworkerId;
    }

    function installPackDefinition(pack, persistedPackId = pack.id) {
        const normalizedPackId = safeId(persistedPackId, "packId");
        const existing = state.teams.find((entry) => entry.packId === normalizedPackId);
        if (existing)
            return { installed: false, team: publicTeam(existing) };
        if (state.teams.length >= MAX_TEAMS)
            throw new Error(`team limit reached (${MAX_TEAMS})`);

        const idsByKey = new Map(pack.coworkers.map((definition) => [definition.key, ensureCoworker(definition)]));
        const coworkerIds = pack.coworkers.map((definition) => idsByKey.get(definition.key));
        const teamId = makeTeamId();
        safeId(teamId, "teamId", TEAM_ID);
        const managed = services.createManagedWorkspace({ label: `${pack.name} project`, kind: "shared-project", idHint: teamId });
        const sharedWorkspaceId = managed.workspace?.id;
        safeId(sharedWorkspaceId, "sharedWorkspaceId");
        const timestamp = now();
        const team = {
            id: teamId,
            packId: normalizedPackId,
            name: pack.name,
            coworkerIds,
            sharedWorkspaceId,
            channelIds: [],
            playbooks: clone(pack.playbooks),
            coworkerKeyById: Object.fromEntries([...idsByKey.entries()].map(([key, id]) => [id, key])),
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.teams.push(team);
        state.flows[team.id] = { stage: "complete", updatedAt: timestamp };

        for (const definition of pack.channels) {
            const channelId = makeChannelId();
            safeId(channelId, "channelId", CHANNEL_ID);
            const conversation = conversationStore.createTeam({
                title: definition.name,
                coworkerIds,
                leadCoworkerId: idsByKey.get("chief"),
                deduplicate: false,
            });
            const channel = {
                id: channelId,
                teamId: team.id,
                kind: definition.kind,
                name: definition.name,
                instructions: definition.instructions,
                coworkerIds: [...coworkerIds],
                workspaceId: sharedWorkspaceId,
                conversationId: conversation.id,
                playbookId: definition.playbookId,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            state.channels.push(channel);
            team.channelIds.push(channel.id);
        }
        save();
        return { installed: true, team: publicTeam(team) };
    }

    function installPack(packId = SOFTWARE_TEAM_PACK.id) {
        const pack = TEAM_PACK_BY_ID.get(packId);
        if (!pack)
            throw new Error(`unknown team pack: ${packId}`);
        return installPackDefinition(pack, pack.id);
    }

    function exportPack(teamId) {
        const team = requireTeam(teamId);
        const builtIn = TEAM_PACK_BY_ID.get(team.packId);
        if (builtIn)
            return exportablePack(builtIn);

        const keyByCoworkerId = new Map(team.coworkerIds.map((id, index, ids) => [
            id,
            team.coworkerKeyById?.[id] ?? (index === 0 ? "chief" : index === ids.length - 1 ? "reviewer" : `specialist-${index}`),
        ]));
        const pack = {
            id: team.packId === "custom-team" ? "custom-team-pack" : team.packId,
            name: team.name,
            description: "A SovereignBot team pack exported from an existing team.",
            coworkers: team.coworkerIds.map((id) => {
                const coworker = coworkerStore.getInternal(id);
                return {
                    key: keyByCoworkerId.get(id),
                    name: coworker.name,
                    role: coworker.role,
                    instructions: coworker.instructions,
                    ...(coworker.avatar ? { avatar: coworker.avatar } : {}),
                    modelBinding: safePackModelBinding(coworker.modelBinding),
                };
            }),
            channels: team.channelIds.map((channelId, index) => {
                const channel = requireChannel(channelId);
                return {
                    key: `channel-${index + 1}`,
                    name: channel.name,
                    kind: channel.kind,
                    instructions: channel.instructions,
                    playbookId: channel.playbookId,
                };
            }),
            playbooks: team.playbooks.map((playbook) => ({
                id: playbook.id,
                name: playbook.name,
                description: playbook.description,
                steps: playbook.steps.map((step) => keyByCoworkerId.get(step) ?? step),
            })),
        };
        return exportablePack(safePackDefinition(pack));
    }

    // Gallery actions need the same portable, declarative document for an
    // installed team and for a first-party recipe that has not been installed
    // yet. No workspace, credential, provider session, or filesystem path is
    // included in either branch.
    function exportPackRecipe(packId) {
        const builtIn = TEAM_PACK_BY_ID.get(String(packId));
        if (builtIn) return exportablePack(builtIn);
        const team = state.teams.find((entry) => entry.packId === String(packId));
        if (!team) throw new Error(`unknown team pack: ${packId}`);
        const exported = exportPack(team.id);
        return exported.id === String(packId) ? exported : { ...exported, id: String(packId) };
    }

    function importPack(input) {
        const pack = safePackDefinition(input, { requireSchema: true });
        return {
            imported: true,
            ...installPackDefinition(pack, `imported:${pack.id}`),
        };
    }

    function exportPlaybook(teamId, playbookId) {
        const team = requireTeam(teamId);
        const playbook = team.playbooks.find((entry) => entry.id === String(playbookId));
        if (!playbook) throw new Error(`unknown playbook id: ${playbookId}`);
        return { schema: TEAM_PLAYBOOK_EXPORT_SCHEMA, ...clone(playbook) };
    }

    function importPlaybook(teamId, input) {
        const team = requireTeam(teamId);
        const playbook = safePlaybookDefinition(input, { requireSchema: true });
        const existing = team.playbooks.find((entry) => entry.id === playbook.id);
        if (existing) {
            if (JSON.stringify({ schema: TEAM_PLAYBOOK_EXPORT_SCHEMA, ...existing }) === JSON.stringify(playbook))
                return { imported: false, playbook: clone(existing), team: publicTeam(team) };
            throw new Error(`playbook id already exists in team: ${playbook.id}`);
        }
        if (team.playbooks.length >= 8) throw new Error("team playbook limit reached (8)");
        team.playbooks.push({ id: playbook.id, name: playbook.name, description: playbook.description, steps: [...playbook.steps], ...safePlaybookSemantics(playbook) });
        team.updatedAt = now();
        save();
        return { imported: true, playbook: clone(playbook), team: publicTeam(team) };
    }

    function updatePlaybook(teamId, playbookId, patch = {}) {
        const team = requireTeam(teamId);
        const playbook = team.playbooks.find((entry) => entry.id === String(playbookId));
        if (!playbook) throw new Error(`unknown playbook id: ${playbookId}`);
        if (!patch || typeof patch !== "object" || Array.isArray(patch))
            throw new Error("playbook patch must be an object");
        const allowed = new Set(["name", "description", "steps", "stages", "reviewPoints", "expectedOutput", "recommendedCoworkerRoles", "recommendedSkillIds"]);
        for (const key of Object.keys(patch))
            if (!allowed.has(key)) throw new Error(`playbook field is not editable: ${key}`);
        if (!Object.keys(patch).length) throw new Error("playbook patch must not be empty");
        const next = {
            name: patch.name === undefined ? playbook.name : safeString(patch.name, "playbook name", 120),
            description: patch.description === undefined ? playbook.description : safeOptionalString(patch.description, "playbook description", 500),
            steps: patch.steps === undefined ? [...playbook.steps] : patch.steps,
            ...Object.fromEntries(["stages", "reviewPoints", "expectedOutput", "recommendedCoworkerRoles", "recommendedSkillIds"].map((field) => [field, Object.hasOwn(patch, field) ? patch[field] : playbook[field]]).filter(([, value]) => value !== undefined)),
        };
        if (!Array.isArray(next.steps) || next.steps.length > 12)
            throw new Error("playbook steps must be an array of at most 12 identifiers");
        next.steps = next.steps.map((step) => safeId(step, "playbook step"));
        Object.assign(playbook, next, safePlaybookSemantics(next));
        team.updatedAt = now();
        save();
        return { playbook: clone(playbook), team: publicTeam(team) };
    }

    function createChannelFromTemplate(teamId, templateId) {
        const team = requireTeam(teamId);
        const template = CHANNEL_TEMPLATE_BY_ID.get(String(templateId));
        if (!template) throw new Error(`unknown channel template: ${templateId}`);
        const existing = state.channels.find((entry) => entry.teamId === team.id
            && (entry.templateId === template.id || (template.id === "project" && entry.kind === "project" && entry.name === template.name)));
        if (existing) return { created: false, channel: publicChannel(existing), team: publicTeam(team) };
        if (state.channels.length >= MAX_CHANNELS) throw new Error(`channel limit reached (${MAX_CHANNELS})`);
        const playbookId = team.playbooks[0]?.id;
        if (!playbookId) throw new Error("team has no available playbook for a new channel");
        const channelId = makeChannelId();
        safeId(channelId, "channelId", CHANNEL_ID);
        const conversation = conversationStore.createTeam({
            title: template.name,
            coworkerIds: team.coworkerIds,
            leadCoworkerId: team.coworkerIds[0],
            deduplicate: false,
        });
        const timestamp = now();
        const channel = {
            id: channelId,
            teamId: team.id,
            templateId: template.id,
            kind: template.kind,
            name: template.name,
            instructions: template.instructions,
            coworkerIds: [...team.coworkerIds],
            workspaceId: team.sharedWorkspaceId,
            conversationId: conversation.id,
            playbookId,
            archived: false,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.channels.push(channel);
        team.channelIds.push(channel.id);
        team.updatedAt = timestamp;
        save();
        return { created: true, channel: publicChannel(channel), conversation, team: publicTeam(team) };
    }

    function createChannel({ teamId, name, kind = "project", instructions = "", workspaceId, playbookId } = {}) {
        const team = requireTeam(teamId);
        const normalizedKind = ["work", "personal", "project"].includes(kind) ? kind : undefined;
        if (!normalizedKind) throw new Error("channel kind is invalid");
        const channelName = safeString(name, "channel name", 120);
        const channelInstructions = instructions === undefined || instructions === ""
            ? "A focused room for bounded work, updates, and teammate handoffs."
            : safeString(instructions, "channel instructions", 12_000);
        if (state.channels.length >= MAX_CHANNELS) throw new Error(`channel limit reached (${MAX_CHANNELS})`);
        const boundWorkspaceId = workspaceId === undefined || workspaceId === "" ? team.sharedWorkspaceId : safeId(workspaceId, "workspaceId");
        if (!services.workspacePath(boundWorkspaceId)) throw new Error(`unknown trusted workspace: ${boundWorkspaceId}`);
        const boundPlaybookId = playbookId === undefined || playbookId === ""
            ? team.playbooks[0]?.id
            : safeId(playbookId, "playbookId");
        if (!boundPlaybookId || !team.playbooks.some((entry) => entry.id === boundPlaybookId))
            throw new Error(`unknown team playbook: ${boundPlaybookId}`);
        const channelId = makeChannelId();
        safeId(channelId, "channelId", CHANNEL_ID);
        const conversation = conversationStore.createTeam({
            title: channelName,
            coworkerIds: team.coworkerIds,
            leadCoworkerId: team.coworkerIds[0],
            deduplicate: false,
        });
        const timestamp = now();
        const channel = {
            id: channelId,
            teamId: team.id,
            kind: normalizedKind,
            name: channelName,
            instructions: channelInstructions,
            coworkerIds: [...team.coworkerIds],
            workspaceId: boundWorkspaceId,
            conversationId: conversation.id,
            playbookId: boundPlaybookId,
            archived: false,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.channels.push(channel);
        team.channelIds.push(channel.id);
        team.updatedAt = timestamp;
        save();
        return { created: true, channel: publicChannel(channel), conversation, team: publicTeam(team) };
    }

    function updateChannel(channelId, patch = {}) {
        const channel = requireChannel(channelId);
        const team = requireTeam(channel.teamId);
        const allowed = new Set(["name", "kind", "instructions", "workspaceId", "playbookId"]);
        for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`channel field is not editable: ${key}`);
        if (!Object.keys(patch).length) throw new Error("channel patch must not be empty");
        if (patch.name !== undefined) channel.name = safeString(patch.name, "channel name", 120);
        if (patch.kind !== undefined) {
            if (!["work", "personal", "project"].includes(patch.kind)) throw new Error("channel kind is invalid");
            channel.kind = patch.kind;
        }
        if (patch.instructions !== undefined) channel.instructions = safeString(patch.instructions, "channel instructions", 12_000);
        if (patch.workspaceId !== undefined) {
            const workspaceId = safeId(patch.workspaceId, "workspaceId");
            if (!services.workspacePath(workspaceId)) throw new Error(`unknown trusted workspace: ${workspaceId}`);
            channel.workspaceId = workspaceId;
        }
        if (patch.playbookId !== undefined) {
            const nextPlaybookId = safeId(patch.playbookId, "playbookId");
            if (!team.playbooks.some((entry) => entry.id === nextPlaybookId)) throw new Error(`unknown team playbook: ${nextPlaybookId}`);
            channel.playbookId = nextPlaybookId;
        }
        channel.updatedAt = now();
        team.updatedAt = channel.updatedAt;
        save();
        return { channel: publicChannel(channel), team: publicTeam(team) };
    }

    function setChannelArchived(channelId, archived) {
        const channel = requireChannel(channelId);
        const team = requireTeam(channel.teamId);
        if (!archived && channel.archived === false) return { channel: publicChannel(channel), team: publicTeam(team) };
        if (archived && !channel.archived && state.channels.filter((entry) => entry.teamId === team.id && !entry.archived).length <= 1)
            throw new Error("a team must keep at least one active channel");
        channel.archived = archived === true;
        channel.updatedAt = now();
        team.updatedAt = channel.updatedAt;
        save();
        return { channel: publicChannel(channel), team: publicTeam(team) };
    }

    function createTeam({ title, coworkerIds, leadCoworkerId } = {}) {
        if (state.teams.length >= MAX_TEAMS)
            throw new Error(`team limit reached (${MAX_TEAMS})`);
        const ids = safeCoworkerIds(coworkerIds);
        ids.forEach((id) => {
            const coworker = coworkerStore.get(id);
            if (coworker.state !== "active") throw new Error(`team coworker must be active: ${id}`);
        });
        const lead = leadCoworkerId ?? ids[0];
        if (!ids.includes(lead)) throw new Error("lead coworker must be a member of the team");
        const teamName = title === undefined ? "Team" : safeString(title, "team name", 120);
        const teamId = makeTeamId();
        safeId(teamId, "teamId", TEAM_ID);
        const managed = services.createManagedWorkspace({ label: `${teamName} project`, kind: "shared-project", idHint: teamId });
        const sharedWorkspaceId = managed.workspace?.id;
        safeId(sharedWorkspaceId, "sharedWorkspaceId");
        const timestamp = now();
        const team = {
            id: teamId,
            packId: "custom-team",
            name: teamName,
            coworkerIds: [...ids],
            sharedWorkspaceId,
            channelIds: [],
            playbooks: [{
                id: "team-collaboration",
                name: "Team Collaboration",
                description: "The current owner delegates bounded work to the next teammate and returns the result to the user.",
                steps: ["owner", "teammate", "owner"],
            }],
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        const channelId = makeChannelId();
        safeId(channelId, "channelId", CHANNEL_ID);
        const conversation = conversationStore.createTeam({ title: teamName, coworkerIds: ids, leadCoworkerId: lead });
        const channel = {
            id: channelId,
            teamId: team.id,
            kind: "project",
            name: "Project Channel",
            instructions: "Bounded team collaboration: one owner at a time, explicit handoffs, and a visible result.",
            coworkerIds: [...ids],
            workspaceId: sharedWorkspaceId,
            conversationId: conversation.id,
            playbookId: "team-collaboration",
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        team.channelIds.push(channel.id);
        state.teams.push(team);
        state.channels.push(channel);
        state.flows[team.id] = { stage: "complete", updatedAt: timestamp };
        save();
        return { created: true, team: publicTeam(team), conversation };
    }

    function channelForConversation(conversationId) {
        return state.channels.find((entry) => entry.conversationId === String(conversationId));
    }

    function onMessageQueued({ conversation, message }) {
        if (message?.senderId !== "user") return;
        const channel = channelForConversation(conversation?.id);
        if (!channel) return;
        const team = requireTeam(channel.teamId);
        const current = state.flows[team.id] ?? { stage: "complete" };
        if (current.userMessageId === message.id) return;
        const order = handoffOrder(team);
        const mentionedOwner = message.mentions?.length === 1 && message.mentions[0] !== "everyone" && team.coworkerIds.includes(message.mentions[0])
            ? message.mentions[0]
            : undefined;
        const startsNewRun = current.stage === "complete" || ["completed", "stopped", "attention", "redirected"].includes(current.runStatus) || !current.runId;
        let ownerIndex = startsNewRun ? 0 : indexForFlow(current, order);
        if (mentionedOwner) ownerIndex = Math.max(0, order.indexOf(mentionedOwner));
        if (ownerIndex === undefined) ownerIndex = 0;
        const updatedAt = now();
        state.flows[team.id] = {
            ...current,
            stage: stageForIndex(ownerIndex, order),
            handoffIndex: ownerIndex,
            userMessageId: message.id,
            ...(startsNewRun ? { runId: undefined, requestId: undefined, operationId: undefined, ownerId: undefined, runStatus: undefined, activeProtocol: undefined, activeFanout: undefined } : {}),
            updatedAt,
        };
        delete state.flows[team.id].lastHandoffSourceId;
        delete state.flows[team.id].lastHandoffTargetId;
        team.updatedAt = updatedAt;
        if (!startsNewRun) save();
        if (startsNewRun)
            startRun({ conversationId: conversation.id, ownerId: order[ownerIndex], stage: stageForIndex(ownerIndex, order), messageId: message.id });
    }

    function resolveHandoff({ conversation, coworkerId, source, requestedCoworkerIds = [], allowDirectedTarget = false } = {}) {
        const channel = channelForConversation(conversation?.id);
        if (!channel) return undefined;
        const team = requireTeam(channel.teamId);
        const flow = state.flows[team.id] ?? { stage: "complete" };
        const protocolRequestPending = !flow.activeProtocol || ["requested", "review_requested"].includes(flow.activeProtocol.state);
        if (protocolRequestPending && source?.id && flow.lastHandoffSourceId === source.id && flow.ownerId === flow.lastHandoffTargetId)
            return { target: flow.lastHandoffTargetId, duplicate: true };
        const order = handoffOrder(team);
        const currentIndex = indexForFlow(flow, order);
        const requested = Array.isArray(requestedCoworkerIds)
            ? requestedCoworkerIds.find((id) => id !== coworkerId && team.coworkerIds.includes(id))
            : undefined;
        const currentOwnerId = flow.ownerId ?? (currentIndex === undefined ? undefined : order[currentIndex]);
        if (allowDirectedTarget && currentOwnerId === coworkerId && requested) {
            const nextIndex = order.indexOf(requested);
            return {
                target: requested,
                nextIndex: nextIndex >= 0 ? nextIndex : undefined,
                stage: nextIndex >= 0 ? stageForIndex(nextIndex, order) : "specialist",
                currentIndex,
                team,
                flow,
            };
        }
        let target;
        let routingDecision;
        if (currentIndex !== undefined && order[currentIndex] === coworkerId) {
            if (currentIndex < order.length - 1) {
                const sourceIsTeamMember = source?.senderId && team.coworkerIds.includes(source.senderId);
                const followsDeclaredPackSequence = team.packId !== "custom-team";
                const approvedReview = flow.activeProtocol?.kind === "review" && flow.activeProtocol.state === "approved";
                const dynamic = !requested && !approvedReview && (source?.senderId === "user" || (!followsDeclaredPackSequence && sourceIsTeamMember))
                    ? selectSpecialist({ objective: source.text, currentCoworkerId: coworkerId, candidates: routingCandidates(conversation, coworkerId) })
                    : undefined;
                target = requested ?? dynamic?.targetCoworkerId ?? order[currentIndex + 1];
                const nextIndex = target === order[currentIndex + 1] ? currentIndex + 1 : Math.max(0, order.indexOf(target));
                routingDecision = dynamic && target === dynamic.targetCoworkerId ? dynamic : undefined;
                return { target, nextIndex, stage: stageForIndex(nextIndex, order), routingDecision, currentIndex, team, flow };
            }
            return { target: undefined, terminal: true, currentIndex, team, flow };
        }
        return { target: undefined, currentIndex, team, flow };
    }

    function previewHandoff(args) {
        return resolveHandoff(args)?.target;
    }

    function previewHandoffDecision(args) {
        return resolveHandoff(args);
    }

    function nextHandoff({ conversation, coworkerId, source, requestedCoworkerIds = [], expectedTargetCoworkerId, expectedVersion, expectedRunId, expectedRequestId, expectedOperationId, expectedOperationToken, runtimeProof, allowDirectedTarget = false, requestedProtocolKind, boundedTask, reason } = {}) {
        if (requestedProtocolKind !== undefined && !PROTOCOL_KINDS.has(requestedProtocolKind)) throw new Error("protocol kind is invalid");
        const decision = resolveHandoff({ conversation, coworkerId, source, requestedCoworkerIds, allowDirectedTarget });
        if (!decision) return undefined;
        if (decision.duplicate) return decision.target;
        const { team, flow, target } = decision;
        let acceptedProofId;
        if (expectedTargetCoworkerId !== undefined && expectedTargetCoworkerId !== target)
            throw new Error("handoff proposal changed before commit");
        if (target) {
            if (!runtimeHandoffPreflight)
                throw new Error("trusted runtime handoff preflight is unavailable");
            const targetCoworker = coworkerStore.get(target);
            if (targetCoworker.state !== "active")
                throw new Error(`team handoff target is not active: ${target}`);
            const proof = runtimeProof?.proofId ? runtimeProofs.get(runtimeProof.proofId) : undefined;
            if (!proof || proof.conversationId !== conversation.id || proof.targetCoworkerId !== target || proof.sourceCoworkerId !== coworkerId || proof.version !== (flow.version ?? 0) || proof.runId !== flow.runId || proof.requestId !== flow.requestId || proof.operationId !== flow.operationId || proof.operationToken !== flow.operationToken)
                throw new Error("trusted runtime handoff proof is missing or stale");
            acceptedProofId = runtimeProof.proofId;
        }
        if (expectedVersion !== undefined && expectedVersion !== (flow.version ?? 0)) throw new Error("handoff flow version is stale");
        if (expectedRunId !== undefined && expectedRunId !== flow.runId) throw new Error("handoff run token is stale");
        if (expectedRequestId !== undefined && expectedRequestId !== flow.requestId) throw new Error("handoff request token is stale");
        if (expectedOperationId !== undefined && expectedOperationId !== flow.operationId) throw new Error("handoff operation token is stale");
        if (expectedOperationToken !== undefined && expectedOperationToken !== flow.operationToken) throw new Error("handoff operation proof is stale");
        if (decision.terminal) {
            recordCollaborationEvent({ conversationId: conversation.id, type: "run.completed", status: "completed", actorId: coworkerId, stage: "complete", protocolRequestId: flow.activeProtocol?.protocolRequestId, protocolKind: flow.activeProtocol?.kind, protocolState: "completed", revision: flow.activeProtocol?.revision, runId: flow.runId, requestId: flow.requestId, operationId: flow.operationId, operationToken: flow.operationToken, expectedVersion: expectedVersion ?? (flow.version ?? 0), flowPatch: { stage: "complete", handoffIndex: undefined, ownerId: undefined, runStatus: "completed", activeProtocol: undefined }, idempotencyKey: `run.completed:${source?.id ?? flow.runId}` });
            return undefined;
        }
        const nextRequestId = idFactory("request");
        const nextOperationId = idFactory("operation");
        const nextOperationToken = idFactory("token");
        const nextProtocolKind = requestedProtocolKind ?? (decision.stage === "reviewer" ? "review" : "handoff");
        const nextRevision = flow.activeProtocol?.state === "changes_requested"
            ? (flow.activeProtocol.revision ?? 0) + 1
            : (flow.activeProtocol?.revision ?? 0);
        if (nextRevision > MAX_PROTOCOL_REVISIONS)
            throw new Error("review revision limit was reached");
        const nextProtocol = {
            protocolRequestId: nextRequestId,
            kind: nextProtocolKind,
            state: nextProtocolKind === "review" ? "review_requested" : "requested",
            sourceCoworkerId: coworkerId,
            targetCoworkerId: target,
            ...(nextProtocolKind === "review" ? { reviewerCoworkerId: target } : {}),
            revision: nextRevision,
            ...(boundedTask ? { boundedTask: safeLedgerText(boundedTask, "boundedTask", 800) } : {}),
            ...(reason ? { reason: safeLedgerText(reason, "reason", 400) } : {}),
            candidateArtifactIds: flow.activeProtocol?.candidateArtifactIds ?? [],
        };
        const flowPatch = {
            handoffIndex: decision.nextIndex,
            stage: decision.stage,
            ownerId: target,
            requestId: nextRequestId,
            operationId: nextOperationId,
            operationToken: nextOperationToken,
            runStatus: "active",
            activeProtocol: nextProtocol,
            attentionReason: undefined,
            attentionCoworkerIds: [],
            ...(decision.routingDecision ? { routingDecision: decision.routingDecision } : {}),
            ...(source?.id ? { lastHandoffSourceId: source.id, lastHandoffTargetId: target } : {}),
            updatedAt: now(),
        };
        if (source?.id) {
            // The source message is part of the transition's idempotency key.
        }
        const requestType = nextProtocolKind === "review" ? "review.requested" : "handoff.requested";
        recordCollaborationEvent({ conversationId: conversation.id, type: requestType, status: "active", actorId: coworkerId, ownerId: coworkerId, targetCoworkerId: target, stage: decision.stage, messageId: source?.id, reason, protocolRequestId: nextRequestId, protocolKind: nextProtocolKind, protocolState: nextProtocol.state, revision: nextRevision, parentOperationId: flow.operationId, runId: flow.runId, requestId: nextRequestId, operationId: nextOperationId, operationToken: nextOperationToken, expectedVersion: expectedVersion ?? (flow.version ?? 0), flowPatch, idempotencyKey: `${requestType}:${source?.id ?? "unknown"}:${target}` });
        if (acceptedProofId) {
            const priorProof = runtimeProofs.get(acceptedProofId);
            if (priorProof) runtimeProofs.set(acceptedProofId, { ...priorProof, requestId: nextRequestId, operationId: nextOperationId, operationToken: nextOperationToken, version: (flow.version ?? 0) + 1 });
        }
        return target;
    }

    function requestCollaboration({ conversationId, targetCoworkerId, handoffType, reason, boundedTask } = {}) {
        if (!PROTOCOL_KINDS.has(handoffType)) throw new Error("handoffType must be handoff or review");
        const context = teamContextForConversation(conversationId);
        if (!context) throw new Error("collaboration request requires a managed team channel");
        const { channel, team } = context;
        if (channel.archived) throw new Error("archived channel is read-only");
        const flow = state.flows[team.id] ?? {};
        const order = handoffOrder(team);
        const currentIndex = indexForFlow(flow, order);
        const ownerId = flow.ownerId ?? (currentIndex === undefined ? undefined : order[currentIndex]);
        if (!ownerId || flow.stage === "complete" || flow.runStatus !== "active" || !flow.runId)
            throw new Error("team channel has no active owner");
        if (!team.coworkerIds.includes(ownerId) || coworkerStore.get(ownerId).state !== "active")
            throw new Error("current owner is not an active team member");
        if (!team.coworkerIds.includes(targetCoworkerId)) throw new Error("collaboration target is not a team member");
        if (targetCoworkerId === ownerId) throw new Error("collaboration target must differ from the current owner");
        if (coworkerStore.get(targetCoworkerId).state !== "active") throw new Error("collaboration target is not active");
        if (flow.activeFanout) throw new Error("collaboration request is unavailable while parallel work is active");
        const activeProtocol = safeActiveProtocol(flow.activeProtocol);
        const busyStates = new Set(["requested", "review_requested", "accepted", "review_accepted", "working", "reviewing"]);
        if (activeProtocol && (busyStates.has(activeProtocol.state) || (activeProtocol.kind === "review" && activeProtocol.state === "submitted")))
            throw new Error("another collaboration request is already active");
        const safeTask = safeLedgerText(boundedTask, "boundedTask", 800);
        const safeReason = safeLedgerText(reason, "reason", 400);
        if (!safeTask || !safeReason) throw new Error("boundedTask and reason are required");
        const conversation = conversationStore.get(conversationId);
        const current = collaborationContextForConversation(conversationId);
        const proof = authorizeHandoffTarget({
            conversationId,
            sourceCoworkerId: ownerId,
            targetCoworkerId,
            expectedVersion: current?.version,
            expectedRunId: current?.runId,
            expectedRequestId: current?.requestId,
            expectedOperationId: current?.operationId,
            expectedOperationToken: current?.operationToken,
        });
        let message;
        try {
            const label = handoffType === "review" ? "Review request" : "Handoff";
            message = conversationStore.postCoworkerMessage(conversationId, ownerId, {
                text: `${label}\nBounded task: ${safeTask}\nReason: ${safeReason}`,
                mentions: [targetCoworkerId],
            }, { internal: true, notifyChannelUnread: false });
            nextHandoff({
                conversation,
                coworkerId: ownerId,
                source: message,
                requestedCoworkerIds: [targetCoworkerId],
                expectedTargetCoworkerId: targetCoworkerId,
                expectedVersion: current?.version,
                expectedRunId: current?.runId,
                expectedRequestId: current?.requestId,
                expectedOperationId: current?.operationId,
                expectedOperationToken: current?.operationToken,
                runtimeProof: proof,
                allowDirectedTarget: true,
                requestedProtocolKind: handoffType,
                boundedTask: safeTask,
                reason: safeReason,
            });
        }
        catch (error) {
            if (message) {
                try { conversationStore.markDelivery(conversationId, message.id, targetCoworkerId, "failed", "The collaboration request could not be committed safely."); } catch {}
            }
            throw error;
        }
        return {
            targetCoworkerId,
            message,
            team: publicTeam(team),
            activity: activityForConversation(conversationId, { limit: 12 }),
        };
    }

    function workspaceIdForConversation(conversationId) {
        return channelForConversation(conversationId)?.workspaceId;
    }

    function currentOwnerForConversation(conversationId) {
        const channel = channelForConversation(conversationId);
        if (!channel) return undefined;
        const team = requireTeam(channel.teamId);
        const status = flowStatus(team);
        if (!status.currentOwnerId) return undefined;
        try {
            return coworkerStore.get(status.currentOwnerId).state === "active" ? status.currentOwnerId : undefined;
        }
        catch { return undefined; }
    }

    function isManagedConversation(conversationId) {
        return Boolean(channelForConversation(conversationId));
    }

    function isReviewerForConversation(conversationId, coworkerId) {
        const channel = channelForConversation(conversationId);
        if (!channel) return false;
        const team = requireTeam(channel.teamId);
        return handoffOrder(team).at(-2) === coworkerId;
    }

    function isArchivedConversation(conversationId) {
        return channelForConversation(conversationId)?.archived === true;
    }

    return {
        schema: TEAMS_SCHEMA,
        list() {
            return {
                schema: TEAMS_SCHEMA,
                teams: state.teams.map(publicTeam),
                packs: [
                    ...TEAM_PACKS.map((pack) => ({
                        id: pack.id,
                        name: pack.name,
                        description: pack.description,
                        category: TEAM_PACK_CATEGORY.get(pack.id) ?? "Operations",
                        coworkerNames: pack.coworkers.map((entry) => entry.name),
                        channelNames: pack.channels.map((entry) => entry.name),
                        playbookNames: pack.playbooks.map((entry) => entry.name),
                        installed: state.teams.some((entry) => entry.packId === pack.id),
                    })),
                    ...state.teams
                        .filter((entry) => !TEAM_PACK_BY_ID.has(entry.packId))
                        .map((entry) => ({
                            id: entry.packId,
                            name: entry.name,
                            description: "A reusable team recipe saved in SovereignBot.",
                            category: "Custom",
                            custom: true,
                            coworkerNames: entry.coworkerIds.map(coworkerName),
                            channelNames: entry.channelIds.map((channelId) => state.channels.find((channel) => channel.id === channelId)?.name).filter(Boolean),
                            playbookNames: entry.playbooks.map((playbook) => playbook.name),
                            installed: true,
                        })),
                ],
                channelTemplates: CHANNEL_TEMPLATES.map((template) => ({ ...template })),
            };
        },
        get(teamId) { return publicTeam(requireTeam(teamId)); },
        exportPack,
        exportPackRecipe,
        importPack,
        exportPlaybook,
        importPlaybook,
        updatePlaybook,
        createChannelFromTemplate,
        createChannel,
        updateChannel,
        archiveChannel(channelId) { return setChannelArchived(channelId, true); },
        restoreChannel(channelId) { return setChannelArchived(channelId, false); },
        listChannels({ teamId, includeArchived = false } = {}) {
            const channels = (teamId === undefined ? state.channels : state.channels.filter((entry) => entry.teamId === String(teamId)))
                .filter((entry) => includeArchived === true || !entry.archived);
            if (teamId !== undefined) requireTeam(teamId);
            return { schema: TEAMS_SCHEMA, channels: channels.map(publicChannel) };
        },
        getChannel(channelId) { return publicChannel(requireChannel(channelId)); },
        createTeam,
        installPack,
        onMessageQueued,
        nextHandoff,
        requestCollaboration,
        previewHandoff,
        previewHandoffDecision,
        claimStage,
        acceptProtocol,
        pendingProtocolProof,
        submitProtocolResult,
        recordReviewDecision,
        stopRun,
        recordCollaborationEvent,
        setRuntimeHandoffPreflight,
        authorizeHandoffTarget,
        collaborationContextForConversation,
        fanoutContextForConversation,
        requestFanout,
        requestParallelCollaboration,
        bindFanoutMessage,
        fanoutChildForDelivery,
        fanoutReviewForDelivery,
        fanoutJoinForDelivery,
        acceptFanoutChild,
        completeFanoutChild,
        requestFanoutReview,
        acceptFanoutReview,
        completeFanoutReview,
        acceptFanoutJoin,
        completeFanoutJoin,
        blockFanout,
        fanoutWorkspaceForChild,
        fanoutJoinSummary,
        activity({ conversationId, teamId, limit = 24 } = {}) {
            if (conversationId !== undefined) {
                const context = teamContextForConversation(conversationId);
                if (!context) throw new Error(`unknown team conversation: ${conversationId}`);
                return { schema: COLLABORATION_SCHEMA, conversationId: String(conversationId), teamId: context.team.id, events: activityForConversation(conversationId, { limit }) };
            }
            if (teamId !== undefined) requireTeam(teamId);
            const teams = teamId === undefined ? state.teams : state.teams.filter((entry) => entry.id === String(teamId));
            const conversationIds = new Set(teams.flatMap((entry) => entry.channelIds.map((channelId) => state.channels.find((channel) => channel.id === channelId)?.conversationId).filter(Boolean)));
            const safeLimit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 24));
            return { schema: COLLABORATION_SCHEMA, ...(teamId !== undefined ? { teamId: String(teamId) } : {}), events: state.collaboration.events.filter((entry) => conversationIds.has(entry.conversationId)).slice(-safeLimit).reverse().map(publicCollaborationEvent) };
        },
        workspaceIdForConversation,
        currentOwnerForConversation,
        isManagedConversation,
        isReviewerForConversation,
        isArchivedConversation,
        channelForConversation(conversationId) {
            const channel = channelForConversation(conversationId);
            return channel ? publicChannel(channel) : undefined;
        },
        setCoworkerAppAccessResolver(resolver) {
            if (resolver !== undefined && typeof resolver !== "function") throw new Error("coworker app access resolver must be a function");
            resolveCoworkerAppAccess = resolver;
        },
        routeSpecialist({ conversationId, coworkerId, objective } = {}) {
            const conversation = conversationStore.get(conversationId);
            if (conversation.kind !== "team" || !conversation.participants.includes(coworkerId)) return undefined;
            return selectSpecialist({ objective, currentCoworkerId: coworkerId, candidates: routingCandidates(conversation, coworkerId) });
        },
        status(teamId) { return flowStatus(requireTeam(teamId)); },
    };
}
