import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createId } from "./id.js";

const MAX_KEY = 200;
const MAX_TAGS = 32;
const MAX_TAG = 80;
const MAX_VALUE_TEXT = 20_000;
export const MAX_MEMORY_SEARCH_QUERY = 300;
export const MAX_MEMORY_SEARCH_LIMIT = 100;
const MEMORY_STATES = new Set(["active", "forgotten", "deleted"]);
const SUGGESTION_STATES = new Set(["pending", "approved", "rejected"]);
export const SOURCE_TYPES = new Set(["conversation", "artifact", "job", "correction", "fact"]);
const SENSITIVE_KEYS = /^(?:session(?:id|key|token)?|continu(?:ation|ity)|provider(?:id|account|session)?|account(?:id|namespace)?|token|bearer|cookie|storage(?:state|path|relativepath)?|profile(?:dir|path)?|credential(?:s)?|password|secret|api[-_]?key|authorization|cwd|workspace(?:path|dir)|rawpath|spendcap|budget|usage|cost)$/i;
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s"'<>|?\r\n]+/g;
const UNC_PATH = /\\\\[^\\/\s]+(?:[\\/][^\\/\s]+)+/g;
const POSIX_PATH = /(^|[\s("'=])\/(?:Users|home|tmp|var|private|mnt|opt|workspace|workspaces)(?:\/[^\s"'<>|]*)*/gi;
const SECRET_TEXT = /(?:bearer\s+|authorization\s*[:=]\s*|api[-_]?key\s*[:=]\s*|token\s*[:=]\s*|cookie\s*[:=]\s*|password\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;]+/gi;

function boundedString(value, label, max, { required = false } = {}) {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    const output = value.trim();
    if (required && !output) throw new Error(`${label} is required`);
    if (output.length > max) throw new Error(`${label} exceeds ${max} characters`);
    return output;
}

function safeScope(scope) {
    const value = boundedString(scope, "memory scope", 160, { required: true });
    if (!/^(?:global|agent:[A-Za-z0-9][\w:.-]{0,127}|task:[A-Za-z0-9][\w:.-]{0,127}|coworker:[A-Za-z0-9][\w:.-]{0,127}|team:[A-Za-z0-9][\w:.-]{0,127}|project:[A-Za-z0-9][\w:.-]{0,127})$/.test(value))
        throw new Error("memory scope is invalid");
    return value;
}

function safeKey(key) { return boundedString(key, "memory key", MAX_KEY, { required: true }); }

function safeTags(tags = []) {
    if (!Array.isArray(tags) || tags.length > MAX_TAGS) throw new Error("memory tags are invalid");
    return [...new Set(tags.map((tag) => boundedString(tag, "memory tag", MAX_TAG, { required: true })))];
}

function sanitizeValue(value, key = "value", seen = new Set()) {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
        if (value.length > MAX_VALUE_TEXT) throw new Error("memory text exceeds 20000 characters");
        return value.replace(WINDOWS_PATH, "[REDACTED_PATH]")
            .replace(UNC_PATH, "[REDACTED_PATH]")
            .replace(POSIX_PATH, "$1[REDACTED_PATH]")
            .replace(SECRET_TEXT, "[REDACTED_SECRET]")
            .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
                try { const parsed = new URL(url); return `${parsed.origin}[REDACTED_URL]`; }
                catch { return "[REDACTED_URL]"; }
            });
    }
    if (typeof value !== "object") throw new Error(`memory ${key} has an unsupported value`);
    if (seen.has(value)) throw new Error("memory value cannot be cyclic");
    seen.add(value);
    let output;
    if (Array.isArray(value)) output = value.slice(0, 64).map((entry) => sanitizeValue(entry, key, seen));
    else {
        output = {};
        for (const [childKey, child] of Object.entries(value)) {
            if (SENSITIVE_KEYS.test(childKey)) throw new Error(`memory contains a sensitive field: ${childKey}`);
            output[childKey] = sanitizeValue(child, childKey, seen);
        }
    }
    seen.delete(value);
    return output;
}

function safeProvenance(value) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("memory provenance is invalid");
    const type = boundedString(value.type, "memory provenance type", 32, { required: true });
    if (!SOURCE_TYPES.has(type)) throw new Error("memory provenance type is invalid");
    const sourceId = value.sourceId === undefined ? undefined : boundedString(value.sourceId, "memory provenance sourceId", 160, { required: true });
    if (sourceId !== undefined && !/^[A-Za-z0-9][\w:.-]{0,159}$/.test(sourceId)) throw new Error("memory provenance sourceId is invalid");
    const label = value.label === undefined ? undefined : boundedString(value.label, "memory provenance label", 180, { required: true });
    return { type, ...(sourceId ? { sourceId } : {}), ...(label ? { label } : {}) };
}

function normalizeRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("memory record is invalid");
    const id = boundedString(record.id, "memory id", 160, { required: true });
    const memoryId = boundedString(record.memoryId ?? id, "memory memoryId", 160, { required: true });
    const at = boundedString(record.at, "memory timestamp", 64, { required: true });
    if (!Number.isFinite(Date.parse(at))) throw new Error("memory timestamp is invalid");
    const scope = safeScope(record.scope);
    const key = safeKey(record.key);
    const tags = safeTags(record.tags ?? []);
    if (record.kind !== undefined && !["suggestion", "suggestion-resolution"].includes(record.kind)) throw new Error("memory kind is invalid");
    const state = record.kind === "suggestion" ? (SUGGESTION_STATES.has(record.state) ? record.state : "pending") : (record.kind === "suggestion-resolution" ? record.state : (record.state === undefined ? "active" : record.state));
    if (record.kind === "suggestion-resolution" && !SUGGESTION_STATES.has(state)) throw new Error("suggestion resolution state is invalid");
    if (!MEMORY_STATES.has(state) && record.kind !== "suggestion" && record.kind !== "suggestion-resolution") throw new Error("memory state is invalid");
    const formal = Boolean(record.provenance || record.kind || record.formal);
    return {
        id, memoryId, at, scope, key,
        ...(record.value === undefined ? {} : { value: formal ? sanitizeValue(record.value) : structuredClone(record.value) }),
        tags,
        ...(record.kind ? { kind: record.kind } : {}),
        ...(record.revision === undefined ? {} : { revision: Number.isInteger(record.revision) && record.revision > 0 ? record.revision : 1 }),
        state,
        ...(record.pinned === true ? { pinned: true } : {}),
        ...(record.provenance ? { provenance: safeProvenance(record.provenance) } : {}),
        ...(record.suggestionId ? { suggestionId: boundedString(record.suggestionId, "suggestion id", 160, { required: true }) } : {}),
    };
}

function normalizeSearchText(value) {
    return String(value ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

function safeSearchQuery(query) {
    if (query === undefined || query === null) return "";
    if (typeof query !== "string") throw new Error("memory search query must be a string");
    if (query.length > MAX_MEMORY_SEARCH_QUERY) throw new Error(`memory search query exceeds ${MAX_MEMORY_SEARCH_QUERY} characters`);
    if ([...query].some((char) => char.charCodeAt(0) < 32 && !["\t", "\n"].includes(char))) throw new Error("memory search query contains control characters");
    return normalizeSearchText(query);
}

function safeSearchLimit(limit) {
    if (limit === undefined) return 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_SEARCH_LIMIT) throw new Error(`memory search limit must be an integer from 1 to ${MAX_MEMORY_SEARCH_LIMIT}`);
    return limit;
}

function searchableFields(record) {
    const value = record.value && typeof record.value === "object" && !Array.isArray(record.value) ? record.value : {};
    return {
        key: normalizeSearchText(record.key),
        title: normalizeSearchText(value.title),
        content: normalizeSearchText(value.content ?? (record.value === undefined ? "" : JSON.stringify(record.value))),
        tags: record.tags.map(normalizeSearchText).filter(Boolean),
    };
}

function scoreRecord(record, query) {
    if (!query) return { score: 0, key: "recent", fields: [], coverage: 1 };
    const fields = searchableFields(record);
    const queryTokens = query.split(" ").filter(Boolean);
    const matchedFields = new Set();
    let score = 0;
    for (const token of queryTokens) {
        const keyExact = fields.key === token;
        const titleExact = fields.title === token;
        const keyPrefix = fields.key.startsWith(token);
        const titlePrefix = fields.title.startsWith(token);
        const keyContains = fields.key.includes(token);
        const titleContains = fields.title.includes(token);
        const tagExact = fields.tags.some((tag) => tag === token);
        const tagContains = fields.tags.some((tag) => tag.includes(token));
        const contentContains = fields.content.includes(token);
        if (!(keyContains || titleContains || tagContains || contentContains)) return null;
        if (keyExact) { score += 240; matchedFields.add("key"); }
        else if (keyPrefix) { score += 180; matchedFields.add("key"); }
        else if (keyContains) { score += 110; matchedFields.add("key"); }
        if (titleExact) { score += 220; matchedFields.add("title"); }
        else if (titlePrefix) { score += 170; matchedFields.add("title"); }
        else if (titleContains) { score += 100; matchedFields.add("title"); }
        if (tagExact) { score += 190; matchedFields.add("tags"); }
        else if (tagContains) { score += 130; matchedFields.add("tags"); }
        if (contentContains) { score += 40; matchedFields.add("content"); }
    }
    const phraseFields = ["key", "title", "tags", "content"].filter((field) => {
        const value = fields[field];
        return Array.isArray(value) ? value.some((entry) => entry.includes(query)) : value.includes(query);
    });
    for (const field of phraseFields) score += field === "title" ? 140 : field === "key" ? 100 : field === "tags" ? 90 : 70;
    const coverage = queryTokens.length ? queryTokens.length / queryTokens.length : 1;
    const key = fields.key === query ? "key-exact"
        : fields.title === query ? "title-exact"
            : fields.key.startsWith(query) ? "key-prefix"
                : fields.title.startsWith(query) ? "title-prefix"
                    : phraseFields.length && queryTokens.length > 1 ? "phrase"
                        : matchedFields.has("tags") ? "tags"
                            : matchedFields.has("content") ? "content" : "token";
    return { score, key, fields: [...matchedFields].sort(), coverage: Number(coverage.toFixed(3)) };
}

export function rankMemoryRecords(records, { query, tags = [], limit, includeForgotten = false } = {}) {
    const normalizedQuery = safeSearchQuery(query);
    const safeLimit = safeSearchLimit(limit);
    const filterTags = safeTags(tags).map(normalizeSearchText);
    const ranked = records.map((record, index) => ({ record, index })).filter(({ record }) => {
        if (!includeForgotten && record.state !== "active") return false;
        return filterTags.every((tag) => record.tags.some((entry) => normalizeSearchText(entry) === tag));
    }).map(({ record, index }) => {
        const match = scoreRecord(record, normalizedQuery);
        if (!match) return undefined;
        return { record, index, ...match, score: match.score + (record.pinned === true ? 8 : 0), pinned: record.pinned === true, updatedAt: Date.parse(record.at) || 0 };
    }).filter(Boolean);
    ranked.sort((a, b) => b.score - a.score || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || b.index - a.index);
    return ranked.slice(0, safeLimit).map(({ record, index, score, key, fields, coverage, pinned }) => ({
        record: structuredClone(record),
        score,
        matchReason: { key, fields, coverage, pinned },
        index,
    }));
}

export class MemoryStore {
    path;
    #writeQueue = Promise.resolve();
    constructor(path) { this.path = path; }

    async #append(record) {
        const line = `${JSON.stringify(normalizeRecord(record))}\n`;
        const write = this.#writeQueue.catch(() => {}).then(async () => {
            await mkdir(dirname(this.path), { recursive: true });
            await appendFile(this.path, line, "utf8");
        });
        this.#writeQueue = write.catch(() => {});
        await write;
    }

    async #records() {
        try {
            const raw = await readFile(this.path, "utf8");
            return raw.split(/\r?\n/).filter(Boolean).map((line) => normalizeRecord(JSON.parse(line)));
        }
        catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    }

    async put(input) {
        const id = input.id ?? createId("mem");
        const record = normalizeRecord({ ...input, id, memoryId: input.memoryId ?? id, at: input.at ?? new Date().toISOString(), revision: input.revision ?? 1, state: "active" });
        await this.#append(record);
        return structuredClone(record);
    }

    async all({ includeForgotten = false } = {}) {
        const latest = new Map();
        for (const record of await this.#records()) {
            if (record.kind === "suggestion" || record.kind === "suggestion-resolution") continue;
            latest.set(record.memoryId, record);
        }
        return [...latest.values()].filter((record) => includeForgotten || record.state === "active").map((record) => structuredClone(record));
    }

    async latest(scope, key) {
        return (await this.all()).filter((record) => record.scope === scope && record.key === key).at(-1);
    }

    async search(input = {}) {
        return (await this.searchDetailed(input)).map(({ record }) => record);
    }

    async searchDetailed(input = {}) {
        const scope = input.scope ? safeScope(input.scope) : undefined;
        const records = (await this.all({ includeForgotten: input.includeForgotten === true })).filter((record) => !scope || record.scope === scope);
        return rankMemoryRecords(records, input);
    }

    async history(memoryId) {
        const id = boundedString(memoryId, "memory id", 160, { required: true });
        return (await this.#records()).filter((record) => record.memoryId === id && !["suggestion", "suggestion-resolution"].includes(record.kind)).map((record) => structuredClone(record));
    }

    async #mutate(memoryId, patch) {
        const current = (await this.all({ includeForgotten: true })).find((record) => record.memoryId === memoryId);
        if (!current) throw new Error(`memory not found: ${memoryId}`);
        const next = normalizeRecord({ ...current, ...patch, id: current.id, memoryId: current.memoryId, at: new Date().toISOString(), revision: (current.revision ?? 1) + 1 });
        await this.#append(next);
        return structuredClone(next);
    }

    async edit(memoryId, patch = {}) {
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("memory patch is invalid");
        for (const key of Object.keys(patch)) if (!["key", "value", "tags"].includes(key)) throw new Error(`memory patch field is not allowed: ${key}`);
        return this.#mutate(boundedString(memoryId, "memory id", 160, { required: true }), {
            ...(Object.hasOwn(patch, "key") ? { key: safeKey(patch.key) } : {}),
            ...(Object.hasOwn(patch, "value") ? { value: sanitizeValue(patch.value) } : {}),
            ...(Object.hasOwn(patch, "tags") ? { tags: safeTags(patch.tags) } : {}),
            state: "active",
        });
    }

    async forget(memoryId) { return this.#mutate(boundedString(memoryId, "memory id", 160, { required: true }), { value: undefined, state: "forgotten", pinned: false }); }
    async delete(memoryId) { return this.#mutate(boundedString(memoryId, "memory id", 160, { required: true }), { value: undefined, state: "deleted", pinned: false }); }
    async pin(memoryId, pinned = true) { return this.#mutate(boundedString(memoryId, "memory id", 160, { required: true }), { pinned: pinned === true, state: "active" }); }

    async suggest({ scope, key, value, tags = [], provenance } = {}) {
        const suggestionId = createId("suggestion");
        const record = normalizeRecord({
            id: suggestionId, memoryId: suggestionId, at: new Date().toISOString(), scope: safeScope(scope), key: safeKey(key),
            value: sanitizeValue(value), tags: safeTags(tags), kind: "suggestion", state: "pending", provenance: safeProvenance(provenance), suggestionId,
        });
        await this.#append(record);
        return structuredClone(record);
    }

    async suggestions() {
        const latest = new Map();
        for (const record of await this.#records()) {
            if (record.kind === "suggestion") latest.set(record.suggestionId, record);
            if (record.kind === "suggestion-resolution") latest.set(record.suggestionId, { ...latest.get(record.suggestionId), ...record });
        }
        return [...latest.values()].filter(Boolean).map((record) => structuredClone(record));
    }

    async resolveSuggestion(suggestionId, state) {
        const id = boundedString(suggestionId, "suggestion id", 160, { required: true });
        if (!SUGGESTION_STATES.has(state) || state === "pending") throw new Error("suggestion resolution is invalid");
        const current = (await this.suggestions()).find((entry) => entry.suggestionId === id);
        if (!current) throw new Error(`suggestion not found: ${id}`);
        await this.#append({ id: createId("suggestion-event"), memoryId: id, suggestionId: id, at: new Date().toISOString(), scope: "global", key: `suggestion:${id}`, kind: "suggestion-resolution", state });
        return { ...structuredClone(current), state };
    }
}
