// Runtime records are durable diagnostics or public projections.  They may keep
// ordinary domain values, but must never carry provider continuity, credentials,
// profile/workspace paths, or raw provider-account identifiers.
const OMIT_RUNTIME_KEY = /^(?:session[_-]?id|continuity|continuation(?:[_-]?(?:ref|url))?|provider[_-]?continuity|harnessstate|executioncontext|cwd|path|workspace(?:path|dir)|profile(?:path|dir)|user[-_]?data(?:dir)?|storage(?:relative)?path|provider[_-]?account(?:[_-]?id)?|account[_-]?id)$/i;
const REDACT_RUNTIME_KEY = /^(?:password|passwd|secret|secret[_-]?value|token|authorization|cookie|set-cookie|api[_-]?key)$/i;
const FIELD_NAME_ARRAY_KEY = /^(?:keys|fields|fieldnames)$/i;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/])[^"'<>|?\r\n]+/g;
const UNC_PATH = /\\\\[^\\/\s]+(?:[\\/][^\\/\s]+)+/g;
const POSIX_PRIVATE_PATH = /(^|[\s("'=])\/(?:Users|home|tmp|var|private|mnt|opt|workspace|workspaces)(?:\/[^\s"'<>|]*)*/gi;

function redactPathLikeText(value) {
    return String(value)
        .replace(WINDOWS_PATH, "[REDACTED_PATH]")
        .replace(UNC_PATH, "[REDACTED_PATH]")
        .replace(POSIX_PRIVATE_PATH, "$1[REDACTED_PATH]");
}

// `undefined` means that the property must be omitted.  This keeps sensitive
// field names such as `sessionId` out of JSONL records as well as their values.
export function sanitizeRuntimeData(value, key, eventType, options = {}) {
    if (key && OMIT_RUNTIME_KEY.test(key)) {
        if (options.preserveProviderSessionMarker && /^session[_-]?id$/i.test(key))
            return "[REDACTED]";
        return undefined;
    }
    if (key && REDACT_RUNTIME_KEY.test(key))
        return "[REDACTED]";
    if (eventType?.startsWith("computer.secret_") && key === "error")
        return "secret operation failed";
    if (eventType?.startsWith("computer.secret_") && /^(text|content|value)$/i.test(key ?? ""))
        return "[REDACTED]";
    if (Array.isArray(value)) {
        return value
            .map((item) => sanitizeRuntimeData(item, undefined, eventType, options))
            .filter((item) => item !== undefined)
            .filter((item) => !(FIELD_NAME_ARRAY_KEY.test(key ?? "") && typeof item === "string" && OMIT_RUNTIME_KEY.test(item)));
    }
    if (value && typeof value === "object") {
        const output = {};
        for (const [childKey, child] of Object.entries(value)) {
            const sanitized = sanitizeRuntimeData(child, childKey, eventType, options);
            if (sanitized !== undefined)
                output[childKey] = sanitized;
        }
        return output;
    }
    return typeof value === "string" ? redactPathLikeText(value) : value;
}
