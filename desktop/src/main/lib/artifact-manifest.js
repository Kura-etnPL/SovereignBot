const MARKER = "SOVEREIGN_ARTIFACTS:";
const MAX_DECLARATIONS = 12;

function safeRelativePath(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 1_024)
        return undefined;
    const path = value.trim().replaceAll("\\", "/");
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0"))
        return undefined;
    if (path.split("/").some((part) => !part || part === "." || part === ".."))
        return undefined;
    return path;
}

export function artifactPromptInstruction() {
    return (
        "If you created durable user-facing files that should appear in the conversation, append exactly one final line: " +
        `${MARKER} [{\"path\":\"relative/path.ext\",\"title\":\"Short title\"}]. ` +
        "Paths must be relative to your trusted working directory. Do not list temporary files, dependencies, caches, secrets, or files you did not create/update for this request. Omit the line entirely when there are no artifacts."
    );
}

export function extractArtifactManifest(providerText) {
    const original = typeof providerText === "string" ? providerText : "";
    const lines = original.replace(/\r\n/g, "\n").split("\n");
    let markerIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index].trim())
            continue;
        if (lines[index].trimStart().startsWith(MARKER))
            markerIndex = index;
        break;
    }
    if (markerIndex < 0)
        return { text: original.trim(), declarations: [] };

    const raw = lines[markerIndex].trim().slice(MARKER.length).trim();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { text: original.trim(), declarations: [], invalidManifest: true };
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_DECLARATIONS)
        return { text: original.trim(), declarations: [], invalidManifest: true };

    const declarations = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return { text: original.trim(), declarations: [], invalidManifest: true };
        const keys = Object.keys(entry).sort();
        if (keys.some((key) => !["path", "title"].includes(key)))
            return { text: original.trim(), declarations: [], invalidManifest: true };
        const path = safeRelativePath(entry.path);
        if (!path)
            return { text: original.trim(), declarations: [], invalidManifest: true };
        const title = entry.title === undefined ? undefined : typeof entry.title === "string" ? entry.title.trim().slice(0, 180) : undefined;
        if (entry.title !== undefined && !title)
            return { text: original.trim(), declarations: [], invalidManifest: true };
        if (!declarations.some((existing) => existing.path.toLowerCase() === path.toLowerCase()))
            declarations.push({ path, ...(title ? { title } : {}) });
    }

    const visible = [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)].join("\n").trim();
    return { text: visible, declarations };
}
