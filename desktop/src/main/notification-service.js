import { join } from "node:path";
import { loadJsonState, saveJsonState } from "./lib/desktop-state.js";
import { NOTIFICATION_CATEGORIES } from "./services.js";

export const NOTIFICATIONS_SCHEMA = "sovereignbot.desktop.notifications.v1";

function clean(value, max = 240) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// Desktop notifications are deliberately a small, local, deduplicated event sink.
// It has no push transport and never carries provider sessions, paths, or credentials.
export function createNotificationService({ dataDir, getSettings, NotificationClass }) {
    if (!dataDir || typeof getSettings !== "function") throw new Error("notification service requires dataDir and settings");
    const persistPath = join(dataDir, "desktop-state", "notifications.json");
    const loaded = loadJsonState(persistPath, null);
    const seen = new Map(Array.isArray(loaded?.events)
        ? loaded.events.filter((entry) => entry?.key && NOTIFICATION_CATEGORIES.includes(entry.category)).map((entry) => [entry.key, entry])
        : []);

    function persist() {
        const events = [...seen.values()].slice(-500);
        saveJsonState(persistPath, { schema: NOTIFICATIONS_SCHEMA, events });
    }

    function enabled(category) {
        const settings = getSettings();
        return settings?.notifications !== false && settings?.notificationPreferences?.[category] !== false;
    }

    function notify({ category, key, title, body }) {
        if (!NOTIFICATION_CATEGORIES.includes(category)) throw new Error(`unsupported notification category: ${category}`);
        const safeKey = clean(key, 180);
        if (!safeKey || seen.has(safeKey) || !enabled(category)) return { shown: false, deduplicated: seen.has(safeKey) };
        const event = { key: safeKey, category, at: new Date().toISOString() };
        seen.set(safeKey, event);
        persist();
        if (!NotificationClass || NotificationClass.isSupported?.() === false) return { shown: false, deduplicated: false };
        try {
            new NotificationClass({ title: clean(title, 120), body: clean(body, 400), silent: true }).show();
            return { shown: true, deduplicated: false };
        }
        catch {
            return { shown: false, deduplicated: false };
        }
    }

    return {
        notify,
        seenCount: () => seen.size,
        isEnabled: enabled,
    };
}
