const MARKER = "SOVEREIGN_HANDOFFS:";
const MAX_HANDOFFS = 4;

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
