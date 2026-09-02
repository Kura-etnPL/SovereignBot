import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { NOTIFICATION_CATEGORIES } from "./services.js";

export const NOTIFICATIONS_SCHEMA = "sovereignbot.desktop.notifications.v1";

const MAX_NOTIFICATIONS = 500;

function clean(value, max = 240) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const ALLOWED_NAV_TARGETS = Object.freeze(new Set([
    "attention", "routines", "triggers", "work", "conversation", "artifacts",
]));

function sanitizeSource(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const target = clean(source.target || source.kind, 40);
    if (!ALLOWED_NAV_TARGETS.has(target)) return null;
    const out = { target };
    if (source.jobId && typeof source.jobId === "string") {
        out.jobId = clean(source.jobId, 120);
    }
    if (source.routineId && typeof source.routineId === "string") {
        out.routineId = clean(source.routineId, 120);
    }
    if (source.triggerId && typeof source.triggerId === "string") {
        out.triggerId = clean(source.triggerId, 120);
    }
    if (source.conversationId && typeof source.conversationId === "string") {
        out.conversationId = clean(source.conversationId, 120);
    }
    if (source.artifactId && typeof source.artifactId === "string") {
        out.artifactId = clean(source.artifactId, 120);
    }
    return Object.freeze(out);
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

function toPublicNotification(item) {
    return Object.freeze({
        id: item.id,
        key: item.key,
        category: item.category,
        title: item.title,
        body: item.body,
        createdAt: item.createdAt || item.at,
        read: item.read === true,
        readAt: item.readAt ?? null,
        source: item.source ? sanitizeSource(item.source) : null,
    });
}

function normalizeLoadedEntry(entry) {
    if (!entry || typeof entry !== "object" || !entry.key) return null;
    if (!NOTIFICATION_CATEGORIES.includes(entry.category)) return null;
    const safeKey = clean(entry.key, 180);
    if (!safeKey) return null;
    const createdAt = entry.createdAt || entry.at || new Date().toISOString();
    return {
        id: entry.id ? clean(entry.id, 200) : `notif_${safeKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        key: safeKey,
        category: entry.category,
        title: clean(entry.title || defaultTitle(entry.category), 120),
        body: clean(entry.body || "", 400),
        createdAt,
        at: createdAt,
        read: entry.read === true,
        readAt: entry.readAt ? String(entry.readAt) : null,
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
    if (Array.isArray(loaded?.events)) {
        for (const raw of loaded.events) {
            const normalized = normalizeLoadedEntry(raw);
            if (normalized) seen.set(normalized.key, normalized);
        }
    }

    function persist() {
        if (seen.size > MAX_NOTIFICATIONS) {
            const excess = seen.size - MAX_NOTIFICATIONS;
            const keys = [...seen.keys()].slice(0, excess);
            for (const k of keys) seen.delete(k);
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
        if (seen.has(safeKey)) return { shown: false, deduplicated: true };

        const createdAt = new Date().toISOString();
        const safeTitle = clean(title || defaultTitle(category), 120);
        const safeBody = clean(body || "", 400);
        const event = {
            id: `notif_${safeKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            key: safeKey,
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
        seen.set(safeKey, event);
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

    function findEntry(idOrKey) {
        if (!idOrKey) return null;
        const target = String(idOrKey);
        if (seen.has(target)) return seen.get(target);
        for (const entry of seen.values()) {
            if (entry.id === target || entry.key === target) return entry;
        }
        return null;
    }

    function list({ category, read, limit = 50 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 50, 100));
        const allActive = [...seen.values()].filter((item) => !item.dismissed);

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

        filtered.sort((a, b) => new Date(b.createdAt || b.at).getTime() - new Date(a.createdAt || a.at).getTime());

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
        const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
        let count = 0;
        for (const entry of seen.values()) {
            if (entry.dismissed) continue;
            if (idSet && !idSet.has(entry.id) && !idSet.has(entry.key)) continue;
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
        const idSet = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
        let count = 0;
        for (const entry of seen.values()) {
            if (entry.dismissed) continue;
            if (idSet && !idSet.has(entry.id) && !idSet.has(entry.key)) continue;
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
