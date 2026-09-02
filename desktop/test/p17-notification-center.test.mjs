import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotificationService, NOTIFICATIONS_SCHEMA } from "../src/main/notification-service.js";
import { fileURLToPath } from "node:url";

class FakeNotification {
  static supported = true;
  static isSupported() { return FakeNotification.supported; }
  static shown = [];
  static reset() { FakeNotification.shown = []; FakeNotification.supported = true; }
  constructor(value) { this.value = value; }
  show() { FakeNotification.shown.push(this.value); }
}

test("notification service reuses desktop-state/notifications.json and preserves backward compatibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-compat-"));
  try {
    const stateDir = join(root, "desktop-state");
    await mkdir(stateDir, { recursive: true });
    // Write legacy notification file with minimal keys
    const legacy = {
      schema: "sovereignbot.desktop.notifications.v1",
      events: [
        { key: "legacy:attention:1", category: "attention", at: "2026-09-01T10:00:00.000Z" },
        { key: "legacy:coworker:2", category: "coworker-finished", at: "2026-09-01T11:00:00.000Z" },
      ],
    };
    await writeFile(join(stateDir, "notifications.json"), JSON.stringify(legacy, null, 2), "utf8");

    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    const listRes = notifications.list();
    assert.equal(listRes.totalCount, 2);
    assert.equal(listRes.unreadCount, 2);
    assert.equal(listRes.notifications.length, 2);

    // Newest first
    assert.equal(listRes.notifications[0].key, "legacy:coworker:2");
    assert.equal(listRes.notifications[0].category, "coworker-finished");
    assert.equal(listRes.notifications[0].title, "Coworker finished");
    assert.equal(listRes.notifications[0].read, false);

    assert.equal(listRes.notifications[1].key, "legacy:attention:1");
    assert.equal(listRes.notifications[1].category, "attention");
    assert.equal(listRes.notifications[1].title, "Attention needed");
    assert.equal(listRes.notifications[1].read, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplication, category allowlist, and bounded storage capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-bounds-"));
  FakeNotification.reset();
  try {
    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    // Rejects unknown category
    assert.throws(
      () => notifications.notify({ category: "invalid-cat", key: "k1" }),
      /unsupported notification category/
    );

    // Deduplication by key
    const res1 = notifications.notify({
      category: "attention",
      key: "task:100",
      title: "Task 100",
      body: "Needs review",
    });
    assert.equal(res1.shown, true);
    assert.equal(res1.deduplicated, false);

    const res2 = notifications.notify({
      category: "attention",
      key: "task:100",
      title: "Task 100 duplicate",
      body: "Needs review again",
    });
    assert.equal(res2.shown, false);
    assert.equal(res2.deduplicated, true);

    // Test bounded capacity (MAX_NOTIFICATIONS = 500)
    for (let i = 0; i < 520; i++) {
      notifications.notify({
        category: "routine-completed",
        key: "bulk:routine:" + i,
        title: "Routine " + i,
        body: "Run completed",
      });
    }

    assert.equal(notifications.seenCount(), 500);
    const listRes = notifications.list({ limit: 100 });
    assert.equal(listRes.totalCount, 500);
    assert.equal(listRes.notifications.length, 100);

    // Verify persisted file in desktop-state/notifications.json also has 500
    const raw = JSON.parse(await readFile(join(root, "desktop-state", "notifications.json"), "utf8"));
    assert.equal(raw.events.length, 500);
    assert.equal(raw.schema, NOTIFICATIONS_SCHEMA);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves inbox events when OS popups are disabled in preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-prefs-"));
  FakeNotification.reset();
  try {
    let settings = {
      notifications: true,
      notificationPreferences: {
        attention: true,
        "routine-completed": false, // disabled popup
      },
    };

    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => settings,
      NotificationClass: FakeNotification,
    });

    const resRoutine = notifications.notify({
      category: "routine-completed",
      key: "routine:quiet:1",
      title: "Silent routine completed",
      body: "Finished in background",
    });

    // Popup is suppressed
    assert.equal(resRoutine.shown, false);
    assert.equal(resRoutine.deduplicated, false);
    assert.equal(FakeNotification.shown.length, 0);

    // But the notification IS stored in inbox!
    const inbox = notifications.list();
    assert.equal(inbox.totalCount, 1);
    assert.equal(inbox.unreadCount, 1);
    assert.equal(inbox.notifications[0].key, "routine:quiet:1");
    assert.equal(inbox.notifications[0].title, "Silent routine completed");

    // Global notifications off
    settings = { notifications: false };
    const resAttn = notifications.notify({
      category: "attention",
      key: "attn:quiet:2",
      title: "Silent attention",
      body: "Global disabled",
    });
    assert.equal(resAttn.shown, false);
    assert.equal(resAttn.deduplicated, false);

    const inbox2 = notifications.list();
    assert.equal(inbox2.totalCount, 2);
    assert.equal(inbox2.notifications[0].key, "attn:quiet:2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markRead, markAllRead, clear, clearAll with restart persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-mutations-"));
  FakeNotification.reset();
  try {
    const service1 = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    service1.notify({ category: "attention", key: "n1", title: "Item 1" });
    service1.notify({ category: "trigger-fired", key: "n2", title: "Item 2" });
    service1.notify({ category: "coworker-finished", key: "n3", title: "Item 3" });
    service1.notify({ category: "channel-unread", key: "n4", title: "Item 4" });

    let list = service1.list();
    assert.equal(list.totalCount, 4);
    assert.equal(list.unreadCount, 4);

    // Mark single item read
    const n1Id = list.notifications.find((e) => e.key === "n1").id;
    const readRes = service1.markRead({ id: n1Id, read: true });
    assert.equal(readRes.success, true);
    assert.equal(readRes.notification.read, true);
    assert.ok(readRes.notification.readAt);

    list = service1.list();
    assert.equal(list.unreadCount, 3);

    // Dismiss single item
    const n2Id = list.notifications.find((e) => e.key === "n2").id;
    const clearRes = service1.clear({ id: n2Id });
    assert.equal(clearRes.success, true);

    list = service1.list();
    assert.equal(list.totalCount, 3); // n2 is dismissed
    assert.equal(list.notifications.some((e) => e.key === "n2"), false);

    // Mark all visible read
    const markAllRes = service1.markAllRead({ ids: [list.notifications[0].id] });
    assert.equal(markAllRes.success, true);
    assert.equal(markAllRes.count, 1);

    // Restart service against same dataDir
    const service2 = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    const listRestart = service2.list();
    assert.equal(listRestart.totalCount, 3); // n2 remains dismissed across restart
    const n1Restart = listRestart.notifications.find((e) => e.key === "n1");
    assert.equal(n1Restart.read, true); // n1 remains read across restart

    // Deduplication survives restart even for dismissed items
    const retriggerDismissed = service2.notify({ category: "trigger-fired", key: "n2", title: "Item 2 again" });
    assert.equal(retriggerDismissed.deduplicated, true);

    // Clear all remaining
    const clearAllRes = service2.clearAll();
    assert.equal(clearAllRes.success, true);
    assert.equal(clearAllRes.count, 3);

    const emptyList = service2.list();
    assert.equal(emptyList.totalCount, 0);
    assert.equal(emptyList.notifications.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("category and read status filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-filters-"));
  try {
    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    notifications.notify({ category: "attention", key: "a1", title: "A1" });
    notifications.notify({ category: "attention", key: "a2", title: "A2" });
    notifications.notify({ category: "routine-completed", key: "r1", title: "R1" });

    // Mark a1 read
    const a1 = notifications.list().notifications.find((e) => e.key === "a1");
    notifications.markRead({ id: a1.id, read: true });

    // Filter category: attention
    const attnList = notifications.list({ category: "attention" });
    assert.equal(attnList.notifications.length, 2);
    assert.equal(attnList.countsByCategory.attention, 2);
    assert.equal(attnList.unreadByCategory.attention, 1);

    // Filter read: false (unread only)
    const unreadList = notifications.list({ read: false });
    assert.equal(unreadList.notifications.length, 2);
    assert.ok(unreadList.notifications.every((e) => !e.read));

    // Filter read: true (read only)
    const readOnlyList = notifications.list({ read: true });
    assert.equal(readOnlyList.notifications.length, 1);
    assert.equal(readOnlyList.notifications[0].key, "a1");

    // Combined filter
    const combined = notifications.list({ category: "attention", read: true });
    assert.equal(combined.notifications.length, 1);
    assert.equal(combined.notifications[0].key, "a1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe source navigation metadata projection and sanitization", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-source-"));
  try {
    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    // Valid allowlisted target: attention
    notifications.notify({
      category: "attention",
      key: "attn:source:1",
      title: "Attn with source",
      source: { target: "attention", jobId: "job_123" },
    });

    // Valid allowlisted target: conversation
    notifications.notify({
      category: "coworker-finished",
      key: "coworker:source:2",
      title: "Coworker with conversation",
      source: { target: "conversation", conversationId: "conv_abc" },
    });

    // Target with authority fields (must be stripped)
    notifications.notify({
      category: "trigger-fired",
      key: "trigger:source:3",
      title: "Trigger with dangerous fields",
      source: {
        target: "triggers",
        triggerId: "trig_999",
        command: "rm -rf /",
        cwd: "C:\\Windows\\System32",
        token: "secret-token-value",
        url: "https://evil.com",
      },
    });

    // Invalid target (must be rejected/null)
    notifications.notify({
      category: "channel-unread",
      key: "channel:source:4",
      title: "Invalid target",
      source: { target: "untrusted-scheme://foo" },
    });

    const items = notifications.list().notifications;
    const attn = items.find((e) => e.key === "attn:source:1");
    assert.deepEqual(attn.source, { target: "attention", jobId: "job_123" });

    const conv = items.find((e) => e.key === "coworker:source:2");
    assert.deepEqual(conv.source, { target: "conversation", conversationId: "conv_abc" });

    const trig = items.find((e) => e.key === "trigger:source:3");
    assert.equal(trig.source.target, "triggers");
    assert.equal(trig.source.triggerId, "trig_999");
    assert.equal(trig.source.command, undefined);
    assert.equal(trig.source.cwd, undefined);
    assert.equal(trig.source.token, undefined);
    assert.equal(trig.source.url, undefined);

    const invalid = items.find((e) => e.key === "channel:source:4");
    assert.equal(invalid.source, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IPC channel registration and schema boundaries", async () => {
  const ipcPath = fileURLToPath(new URL("../src/main/ipc.js", import.meta.url));
  const ipcSource = await readFile(ipcPath, "utf8");

  // Confirm channels exist in NOTIFICATION_CHANNELS and are bound to ALL_IPC_CHANNELS
  assert.match(ipcSource, /NOTIFICATION_CHANNELS = Object\.freeze/);
  assert.match(ipcSource, /"notification:list":/);
  assert.match(ipcSource, /"notification:markRead":/);
  assert.match(ipcSource, /"notification:markAllRead":/);
  assert.match(ipcSource, /"notification:clear":/);
  assert.match(ipcSource, /"notification:clearAll":/);
  assert.match(ipcSource, /\.\.\.NOTIFICATION_CHANNELS,/);

  // Confirm validation logic
  assert.match(ipcSource, /validateNotificationRequest/);
  assert.match(ipcSource, /NOTIFICATION_CATEGORIES_SET/);

  // Confirm NO channel exists for renderer to inject arbitrary notifications
  assert.doesNotMatch(ipcSource, /"notification:create"/);
  assert.doesNotMatch(ipcSource, /"notification:notify"/);

  // Confirm preload exposes notifications surface
  const preloadPath = fileURLToPath(new URL("../src/main/preload.cjs", import.meta.url));
  const preloadSource = await readFile(preloadPath, "utf8");
  assert.match(preloadSource, /notifications: Object\.freeze\({/);
  assert.match(preloadSource, /list: invoke\("notification:list"\)/);
  assert.match(preloadSource, /markRead: invoke\("notification:markRead"\)/);
  assert.match(preloadSource, /markAllRead: invoke\("notification:markAllRead"\)/);
  assert.match(preloadSource, /clear: invoke\("notification:clear"\)/);
  assert.match(preloadSource, /clearAll: invoke\("notification:clearAll"\)/);
});
