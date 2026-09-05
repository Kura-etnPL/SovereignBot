const MARKER = "SOVEREIGN_HANDOFFS:";
const REVIEW_MARKER = "SOVEREIGN_REVIEW:";
const FANOUT_MARKER = "SOVEREIGN_FANOUT:";
const COMPLETION_MARKER = "SOVEREIGN_COMPLETION:";
const MAX_HANDOFFS = 4;
const MAX_FANOUT_CHILDREN = 4;
const MAX_FANOUT_TASK = 800;

function coworkerId(value) {
    return typeof value === "string" && /^coworker_[a-f0-9]{16}$/i.test(value) ? value : undefined;
}

export function handoffPromptInstruction(availableCoworkers) {
    if (!Array.isArray(availableCoworkers) || availableCoworkers.length === 0)
        return "";
    const roster = availableCoworkers.map((entry) => `${entry.name} (${entry.id})`).join(", ");
    return (
        `Other coworkers available in this team: ${roster}. ` +
        "If another coworker should actually take over or contribute next, append exactly one final line: " +
        `${MARKER} [\"coworker_id\"]. ` +
        `Use only IDs from the available list, at most ${MAX_HANDOFFS}, and omit the line when no handoff is needed. ` +
        "A handoff is a work request, not permission to widen tools or authority."
    );
}

export function extractHandoffManifest(providerText, allowedIds = []) {
    const original = typeof providerText === "string" ? providerText : "";
    const allowed = new Set(allowedIds);
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    let markerIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].trim()) continue;
        if (lines[index].trimStart().startsWith(MARKER)) markerIndex = index;
        break;
    }
    if (markerIndex < 0)
        return { text: original.trim(), coworkerIds: [] };

    const visible = [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)].join("\n").trim();
    const invalid = () => ({ text: visible, coworkerIds: [], invalidManifest: true });
    const raw = lines[markerIndex].trim().slice(MARKER.length).trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return invalid(); }
    if (!Array.isArray(parsed) || parsed.length > MAX_HANDOFFS)
        return invalid();

    const coworkerIds = [];
    for (const value of parsed) {
        const id = coworkerId(value);
        if (!id || !allowed.has(id))
            return invalid();
        if (!coworkerIds.includes(id)) coworkerIds.push(id);
    }
    return { text: visible, coworkerIds };
}

export function extractCompletionManifest(providerText) {
    const original = typeof providerText === "string" ? providerText : "";
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    const markerIndexes = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.trimStart().startsWith(COMPLETION_MARKER))
        .map(({ index }) => index);
    if (!markerIndexes.length)
        return { text: original.trim(), requested: false };
    const visible = lines.filter((_, index) => !markerIndexes.includes(index)).join("\n").trim();
    const nonEmptyIndexes = lines.map((line, index) => line.trim() ? index : -1).filter((index) => index >= 0);
    const lastNonEmpty = nonEmptyIndexes.at(-1);
    const markerIndex = markerIndexes.at(-1);
    if (markerIndexes.length !== 1 || markerIndex !== lastNonEmpty)
        return { text: visible, requested: false, invalidManifest: true };
    const raw = lines[markerIndex].trim().slice(COMPLETION_MARKER.length).trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { text: visible, requested: false, invalidManifest: true }; }
    if (parsed !== "reply-only")
        return { text: visible, requested: false, invalidManifest: true };
    return { text: visible, requested: true };
}

export function reviewPromptInstruction() {
    return "review: this is an independent review protocol. Append exactly one final line with only one JSON string: SOVEREIGN_REVIEW: \"approved\" or SOVEREIGN_REVIEW: \"changes-requested\". Do not use any other decision value.";
}

export function fanoutPromptInstruction(availableCoworkers) {
    if (!Array.isArray(availableCoworkers) || availableCoworkers.length < 2)
        return "";
    const roster = availableCoworkers.map((entry) => `${entry.name} (${entry.id})`).join(", ");
    return (
        `For independent parallel work, choose at least two coworkers from this list: ${roster}. ` +
        "Append exactly one final line only when parallel work is genuinely independent: " +
        `${FANOUT_MARKER} {\"reviewerCoworkerId\":\"coworker_id\",\"children\":[{\"key\":\"short-key\",\"coworkerId\":\"coworker_id\",\"task\":\"bounded task\"}]}. ` +
        "Use unique short keys, bounded tasks, and a reviewer who is not a child. Each child receives a private isolated work root."
    );
}

export function extractFanoutManifest(providerText, allowedIds = []) {
    const original = typeof providerText === "string" ? providerText : "";
    const allowed = new Set(allowedIds);
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    let markerIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].trim()) continue;
        if (lines[index].trimStart().startsWith(FANOUT_MARKER)) markerIndex = index;
        break;
    }
    if (markerIndex < 0) return { text: original.trim(), children: [] };
    const visible = [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)].join("\n").trim();
    const invalid = () => ({ text: visible, children: [], invalidManifest: true });
    const raw = lines[markerIndex].trim().slice(FANOUT_MARKER.length).trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return invalid(); }
    const reviewerCoworkerId = Array.isArray(parsed) ? undefined : parsed?.reviewerCoworkerId;
    const children = Array.isArray(parsed) ? parsed : parsed?.children;
    if (!Array.isArray(children) || children.length < 2 || children.length > MAX_FANOUT_CHILDREN)
        return invalid();
    if (reviewerCoworkerId !== undefined && (typeof reviewerCoworkerId !== "string" || !allowed.has(reviewerCoworkerId)))
        return invalid();
    const keys = new Set();
    const normalized = [];
    for (const child of children) {
        if (!child || typeof child !== "object" || Array.isArray(child)) return invalid();
        const key = child.key;
        const coworkerId = child.coworkerId;
        const task = child.task ?? child.boundedTask;
        if (typeof key !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(key) || keys.has(key)) return invalid();
        if (typeof coworkerId !== "string" || !allowed.has(coworkerId)) return invalid();
        if (typeof task !== "string" || !task.trim() || task.length > MAX_FANOUT_TASK) return invalid();
        if (child.requiresComputer !== undefined && typeof child.requiresComputer !== "boolean") return invalid();
        if (child.workspace !== undefined && child.workspace !== "private") return invalid();
        keys.add(key);
        normalized.push({
            key,
            coworkerId,
            task: task.trim(),
            ...(child.requiresComputer === true ? { requiresComputer: true } : {}),
            workspace: "private",
        });
    }
    if (new Set(normalized.map((entry) => entry.coworkerId)).size !== normalized.length)
        return invalid();
    if (reviewerCoworkerId && normalized.some((entry) => entry.coworkerId === reviewerCoworkerId))
        return invalid();
    return { text: visible, reviewerCoworkerId, children: normalized };
}

export function extractReviewDecision(providerText) {
    const original = typeof providerText === "string" ? providerText : "";
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    let markerIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].trim()) continue;
        if (lines[index].trimStart().startsWith(REVIEW_MARKER)) markerIndex = index;
        if (markerIndex >= 0) break;
    }
    if (markerIndex < 0) return { text: original.trim(), decision: undefined };
    const visible = [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)].join("\n").trim();
    const raw = lines[markerIndex].trim().slice(REVIEW_MARKER.length).trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { text: visible, decision: undefined, invalidDecision: true };
    }
    if (!["approved", "changes-requested"].includes(parsed))
        return { text: visible, decision: undefined, invalidDecision: true };
    return { text: visible, decision: parsed };
}
