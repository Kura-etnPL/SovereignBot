import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { NOTIFICATION_CATEGORIES } from "./services.js";

export const NOTIFICATIONS_SCHEMA = "sovereignbot.desktop.notifications.v1";

const MAX_NOTIFICATIONS = 500;

function clean(value, max = 240) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][\w:.-]{0,199}$/;
function isValidOpaqueId(val) {
    return typeof val === "string" && OPAQUE_ID_PATTERN.test(val.trim());
}

const ALLOWED_NAV_TARGETS = Object.freeze(new Set([
    "attention", "routines", "triggers", "work", "conversation", "artifacts",
]));

function sanitizeSource(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const target = clean(source.target || source.kind, 40);
    if (!ALLOWED_NAV_TARGETS.has(target)) return null;

    if (target === "conversation") {
        if (!isValidOpaqueId(source.conversationId)) return null;
        return Object.freeze({ target: "conversation", conversationId: clean(source.conversationId, 120) });
    }
    if (target === "routines") {
        if (!isValidOpaqueId(source.routineId)) return null;
        return Object.freeze({ target: "routines", routineId: clean(source.routineId, 120) });
    }
    if (target === "triggers") {
        if (!isValidOpaqueId(source.triggerId)) return null;
        return Object.freeze({ target: "triggers", triggerId: clean(source.triggerId, 120) });
    }
    if (target === "work") {
        if (!isValidOpaqueId(source.jobId)) return null;
        return Object.freeze({ target: "work", jobId: clean(source.jobId, 120) });
    }
    if (target === "artifacts") {
        if (!isValidOpaqueId(source.artifactId)) return null;
        return Object.freeze({ target: "artifacts", artifactId: clean(source.artifactId, 120) });
    }
    if (target === "attention") {
        const out = { target: "attention" };
        if (isValidOpaqueId(source.jobId)) {
            out.jobId = clean(source.jobId, 120);
        }
        return Object.freeze(out);
    }
    return null;
}

function redactSensitive(text) {
    if (typeof text !== "string") return "";
    let s = text;
    // Redact Windows absolute paths (e.g. C:\Users\... or C:/Users/...)
    s = s.replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[REDACTED_PATH]");
    // Redact Windows UNC paths (e.g. \\server\share\...)
    s = s.replace(/\\\\[^\s"'<>]+/g, "[REDACTED_PATH]");
    // Redact Unix absolute paths in common system/user directories
    s = s.replace(/(?:^|[\s"'])(\/(?:Users|home|var|etc|usr|tmp|opt|private|root)\/[^\s"'<>]*)/g, (match, p1) => match.replace(p1, "[REDACTED_PATH]"));
    // Redact Authorization Bearer headers and standalone Bearer tokens without leaving credential tails
    s = s.replace(/(?:Authorization[:\s]+)?Bearer\s+[^\s\r\n;,]+/gi, "[REDACTED_TOKEN]");
    // Redact Authorization Basic headers and standalone Basic tokens
    s = s.replace(/(?:Authorization[:\s]+)?Basic\s+[^\s\r\n;,]+/gi, "[REDACTED_TOKEN]");
    // Redact generic Authorization: headers
    s = s.replace(/Authorization:\s*[^\s\r\n;,]+/gi, "[REDACTED_TOKEN]");
    // Redact Cookie headers
    s = s.replace(/Cookie[:\s]+[^\s\r\n;,]+(?:;\s*[^\s\r\n;,]+)*/gi, "[REDACTED_TOKEN]");
    // Redact known token prefixes
    s = s.replace(/\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9_-]{20,}|xox[baprs]-[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED_TOKEN]");
    // Redact key-value secret pairs
    s = s.replace(/\b((?:api[-_]?key|token|secret|password|passwd|auth[-_]?token|session[-_]?id|access[-_]?token|refresh[-_]?token|cookie))\s*[:=]\s*["']?([A-Za-z0-9+/=._~-]{8,})["']?/gi, "$1=[REDACTED_SECRET]");
    return s;
}

function cleanAndRedact(value, max = 400) {
    const redacted = redactSensitive(String(value ?? ""));
    return clean(redacted, max);
}

function safeIsoDate(value, fallback = null) {
    if (!value) return fallback;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function generateOpaqueId() {
    return `notif_${randomBytes(8).toString("hex")}`;
}

function opaqueIdForLegacyKey(key) {
    return `notif_${createHash("sha256").update(String(key)).digest("hex").slice(0, 16)}`;
}

// Persist a stable digest identity rather than raw key semantics to prevent
// leaking secrets or absolute paths through dedupe keys.
function digestKey(key) {
    if (typeof key !== "string") return "";
    const cleanKey = clean(key, 180);
    if (!cleanKey) return "";
    if (/^k_[a-f0-9]{32}$/.test(cleanKey)) return cleanKey;
    return `k_${createHash("sha256").update(cleanKey).digest("hex").slice(0, 32)}`;
}

function defaultTitle(category) {
    switch (category) {
        case "attention": return "Attention needed";
        case "routine-completed": return "Routine completed";
        case "trigger-fired": return "Trigger fired";
        case "coworker-finished": return "Coworker finished";
        case "channel-unread": return "Channel unread";
        default: return "Notification";
    }
}

// Public projection never includes internal dedupe key.
function toPublicNotification(item) {
    return Object.freeze({
        id: item.id,
        category: item.category,
        title: item.title,
        body: item.body,
        createdAt: item.createdAt || item.at,
        read: item.read === true,
        readAt: item.readAt ?? null,
        source: item.source ? sanitizeSource(item.source) : null,
    });
}

function normalizeLoadedEntry(entry, existingIds = null) {
    if (!entry || typeof entry !== "object" || !entry.key) return null;
    if (!NOTIFICATION_CATEGORIES.includes(entry.category)) return null;
    const safeKey = clean(entry.key, 180);
    if (!safeKey) return null;
    const dedupeKey = digestKey(safeKey);
    const createdAt = safeIsoDate(entry.createdAt || entry.at, new Date().toISOString());
    let id = (entry.id && typeof entry.id === "string" && /^notif_[a-f0-9]{16}$/.test(entry.id))
        ? entry.id
        : opaqueIdForLegacyKey(safeKey);
    if (existingIds) {
        let counter = 1;
        while (existingIds.has(id)) {
            id = `notif_${createHash("sha256").update(`${safeKey}#${counter++}`).digest("hex").slice(0, 16)}`;
        }
        existingIds.add(id);
    }
    return {
        id,
        key: dedupeKey,
        category: entry.category,
        title: cleanAndRedact(entry.title || defaultTitle(entry.category), 120),
        body: cleanAndRedact(entry.body || "", 400),
        createdAt,
        at: createdAt,
        read: entry.read === true,
        readAt: entry.readAt ? safeIsoDate(entry.readAt, null) : null,
        dismissed: entry.dismissed === true,
        source: sanitizeSource(entry.source),
    };
}

// Desktop notifications are deliberately a small, local, deduplicated event sink.
// It has no push transport and never carries provider sessions, paths, or credentials.
export function createNotificationService({ dataDir, getSettings, NotificationClass }) {
    if (!dataDir || typeof getSettings !== "function") throw new Error("notification service requires dataDir and settings");
    const persistPath = join(dataDir, "desktop-state", "notifications.json");
    const loaded = loadJsonState(persistPath, null);
    const seen = new Map();
    const existingIds = new Set();
    if (Array.isArray(loaded?.events)) {
        for (const raw of loaded.events) {
            const normalized = normalizeLoadedEntry(raw, existingIds);
            if (normalized) seen.set(normalized.key, normalized);
        }
    }

    function persist() {
        if (seen.size > MAX_NOTIFICATIONS) {
            const excess = seen.size - MAX_NOTIFICATIONS;
            const keys = [...seen.keys()].slice(0, excess);
            for (const k of keys) {
                const item = seen.get(k);
                if (item?.id) existingIds.delete(item.id);
                seen.delete(k);
            }
        }
        const events = [...seen.values()];
        saveJsonState(persistPath, { schema: NOTIFICATIONS_SCHEMA, events });
    }

    function enabled(category) {
        const settings = getSettings();
        return settings?.notifications !== false && settings?.notificationPreferences?.[category] !== false;
    }

    function notify({ category, key, title, body, source }) {
        if (!NOTIFICATION_CATEGORIES.includes(category)) throw new Error(`unsupported notification category: ${category}`);
        const safeKey = clean(key, 180);
        if (!safeKey) return { shown: false, deduplicated: false };
        const dedupeKey = digestKey(safeKey);
        if (seen.has(dedupeKey)) return { shown: false, deduplicated: true };

        const createdAt = new Date().toISOString();
        const safeTitle = cleanAndRedact(title || defaultTitle(category), 120);
        const safeBody = cleanAndRedact(body || "", 400);
        let id;
        do {
            id = generateOpaqueId();
        } while (existingIds.has(id));
        existingIds.add(id);

        const event = {
            id,
            key: dedupeKey,
            category,
            title: safeTitle,
            body: safeBody,
            createdAt,
            at: createdAt,
            read: false,
            readAt: null,
            dismissed: false,
            source: sanitizeSource(source),
        };
        seen.set(dedupeKey, event);
        persist();

        // Popup delivery is gated by OS/user settings, but the inbox event is safely preserved.
        if (!enabled(category)) return { shown: false, deduplicated: false };
        if (!NotificationClass || NotificationClass.isSupported?.() === false) return { shown: false, deduplicated: false };
        try {
            new NotificationClass({ title: safeTitle, body: safeBody, silent: true }).show();
            return { shown: true, deduplicated: false };
        }
        catch {
            return { shown: false, deduplicated: false };
        }
    }

    // Mutations only match by opaque id; internal dedupe key is never accepted from renderer.
    function findEntry(id) {
        if (!id || typeof id !== "string") return null;
        const target = id.trim();
        if (!/^notif_[a-f0-9]{16}$/.test(target)) return null;
        for (const entry of seen.values()) {
            if (entry.id === target) return entry;
        }
        return null;
    }

    function list({ category, read, limit = 50 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 100));
        const allActive = [...seen.values()].filter((item) => !item.dismissed).reverse();

        const countsByCategory = {};
        const unreadByCategory = {};
        for (const cat of NOTIFICATION_CATEGORIES) {
            countsByCategory[cat] = 0;
            unreadByCategory[cat] = 0;
        }
        for (const item of allActive) {
            if (countsByCategory[item.category] !== undefined) {
                countsByCategory[item.category] += 1;
                if (!item.read) unreadByCategory[item.category] += 1;
            }
        }

        let filtered = allActive;
        if (category && category !== "all") {
            filtered = filtered.filter((item) => item.category === category);
        }
        if (typeof read === "boolean") {
            filtered = filtered.filter((item) => item.read === read);
        }

        filtered.sort((a, b) => {
            const timeA = new Date(a.createdAt || a.at).getTime() || 0;
            const timeB = new Date(b.createdAt || b.at).getTime() || 0;
            return timeB - timeA;
        });

        const bounded = filtered.slice(0, safeLimit).map(toPublicNotification);
        return {
            notifications: bounded,
            totalCount: allActive.length,
            unreadCount: allActive.filter((item) => !item.read).length,
            countsByCategory,
            unreadByCategory,
        };
    }

    function markRead({ id, read = true } = {}) {
        const entry = findEntry(id);
        if (!entry || entry.dismissed) {
            return { success: false, error: "notification not found" };
        }
        entry.read = Boolean(read);
        entry.readAt = entry.read ? new Date().toISOString() : null;
        persist();
        return { success: true, notification: toPublicNotification(entry) };
    }

    function markAllRead({ category, ids } = {}) {
        let idSet = null;
        if (Array.isArray(ids)) {
            idSet = new Set(ids.map(String).map((s) => s.trim()).filter((s) => /^notif_[a-f0-9]{16}$/.test(s)));
            if (ids.length > 0 && idSet.size === 0) {
                return { success: true, count: 0 };
            }
        }
        let count = 0;
        for (const entry of seen.values()) {
            if (entry.dismissed) continue;
            if (idSet && !idSet.has(entry.id)) continue;
            if (category && category !== "all" && entry.category !== category) continue;
            if (!entry.read) {
                entry.read = true;
                entry.readAt = new Date().toISOString();
                count += 1;
            }
        }
        if (count > 0) persist();
        return { success: true, count };
    }

    function clear({ id } = {}) {
        const entry = findEntry(id);
        if (!entry || entry.dismissed) {
            return { success: false, error: "notification not found" };
        }
        entry.dismissed = true;
        persist();
        return { success: true };
    }

    function clearAll({ category, ids } = {}) {
        let idSet = null;
        if (Array.isArray(ids)) {
            idSet = new Set(ids.map(String).map((s) => s.trim()).filter((s) => /^notif_[a-f0-9]{16}$/.test(s)));
            if (ids.length > 0 && idSet.size === 0) {
                return { success: true, count: 0 };
            }
        }
        let count = 0;
        for (const entry of seen.values()) {
            if (entry.dismissed) continue;
            if (idSet && !idSet.has(entry.id)) continue;
            if (category && category !== "all" && entry.category !== category) continue;
            entry.dismissed = true;
            count += 1;
        }
        if (count > 0) persist();
        return { success: true, count };
    }

    return {
        notify,
        list,
        markRead,
        markAllRead,
        clear,
        clearAll,
        seenCount: () => seen.size,
        isEnabled: enabled,
    };
}
