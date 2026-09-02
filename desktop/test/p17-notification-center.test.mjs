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

test("notification service reuses desktop-state/notifications.json and preserves backward compatibility with stable opaque IDs", async () => {
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

    // Public projections must NEVER expose internal key
    assert.equal(listRes.notifications[0].key, undefined);
    assert.equal(listRes.notifications[1].key, undefined);

    // Opaque IDs must match format notif_[a-f0-9]{16}
    assert.match(listRes.notifications[0].id, /^notif_[a-f0-9]{16}$/);
    assert.match(listRes.notifications[1].id, /^notif_[a-f0-9]{16}$/);

    // Newest first
    assert.equal(listRes.notifications[0].category, "coworker-finished");
    assert.equal(listRes.notifications[0].title, "Coworker finished");
    assert.equal(listRes.notifications[0].read, false);

    assert.equal(listRes.notifications[1].category, "attention");
    assert.equal(listRes.notifications[1].title, "Attention needed");
    assert.equal(listRes.notifications[1].read, false);

    // Deterministic migration: re-creating service against the same legacy file produces identical opaque IDs
    const notificationsReloaded = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });
    const reloadRes = notificationsReloaded.list();
    assert.equal(reloadRes.notifications[0].id, listRes.notifications[0].id);
    assert.equal(reloadRes.notifications[1].id, listRes.notifications[1].id);

    // Mutations must reject raw legacy keys
    assert.equal(notifications.markRead({ id: "legacy:coworker:2" }).success, false);
    assert.equal(notifications.clear({ id: "legacy:coworker:2" }).success, false);
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

    // Deduplication by internal key
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

    // But the notification IS stored in inbox without key in projection
    const inbox = notifications.list();
    assert.equal(inbox.totalCount, 1);
    assert.equal(inbox.unreadCount, 1);
    assert.equal(inbox.notifications[0].key, undefined);
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
    assert.equal(inbox2.notifications[0].key, undefined);
    assert.equal(inbox2.notifications[0].title, "Silent attention");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markRead, markAllRead, clear, clearAll with restart persistence and key-forgery rejection", async () => {
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

    // Reject forgery attempts with raw internal key strings
    assert.equal(service1.markRead({ id: "n1" }).success, false);
    assert.equal(service1.clear({ id: "n2" }).success, false);
    assert.equal(service1.markAllRead({ ids: ["n1", "n2", "job:raw:key"] }).count, 0);

    // Mark single item read using opaque id
    const n1 = list.notifications.find((e) => e.title === "Item 1");
    const n1Id = n1.id;
    const readRes = service1.markRead({ id: n1Id, read: true });
    assert.equal(readRes.success, true);
    assert.equal(readRes.notification.read, true);
    assert.equal(readRes.notification.key, undefined);
    assert.ok(readRes.notification.readAt);

    list = service1.list();
    assert.equal(list.unreadCount, 3);

    // Dismiss single item using opaque id
    const n2 = list.notifications.find((e) => e.title === "Item 2");
    const n2Id = n2.id;
    const clearRes = service1.clear({ id: n2Id });
    assert.equal(clearRes.success, true);

    list = service1.list();
    assert.equal(list.totalCount, 3); // n2 is dismissed
    assert.equal(list.notifications.some((e) => e.id === n2Id), false);

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
    const n1Restart = listRestart.notifications.find((e) => e.title === "Item 1");
    assert.equal(n1Restart.read, true); // n1 remains read across restart
    assert.equal(n1Restart.id, n1Id); // stable opaque id matches original

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
    const a1 = notifications.list().notifications.find((e) => e.title === "A1");
    notifications.markRead({ id: a1.id, read: true });

    // Filter category: attention
    const attnList = notifications.list({ category: "attention" });
    assert.equal(attnList.notifications.length, 2);
    assert.equal(attnList.countsByCategory.attention, 2);
    assert.equal(attnList.unreadByCategory.attention, 1);
    assert.ok(attnList.notifications.every((e) => e.key === undefined));

    // Filter read: false (unread only)
    const unreadList = notifications.list({ read: false });
    assert.equal(unreadList.notifications.length, 2);
    assert.ok(unreadList.notifications.every((e) => !e.read));

    // Filter read: true (read only)
    const readOnlyList = notifications.list({ read: true });
    assert.equal(readOnlyList.notifications.length, 1);
    assert.equal(readOnlyList.notifications[0].title, "A1");

    // Combined filter
    const combined = notifications.list({ category: "attention", read: true });
    assert.equal(combined.notifications.length, 1);
    assert.equal(combined.notifications[0].title, "A1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safe source navigation metadata projection and sanitization: exact per target", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-source-"));
  try {
    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    // Valid allowlisted target: attention with jobId
    notifications.notify({
      category: "attention",
      key: "attn:source:1",
      title: "Attn with source",
      source: { target: "attention", jobId: "job_123" },
    });

    // Valid allowlisted target: attention without jobId (allowed)
    notifications.notify({
      category: "attention",
      key: "attn:source:2",
      title: "Attn without jobId",
      source: { target: "attention" },
    });

    // Valid allowlisted target: conversation with conversationId
    notifications.notify({
      category: "coworker-finished",
      key: "coworker:source:2",
      title: "Coworker with conversation",
      source: { target: "conversation", conversationId: "conv_abc" },
    });

    // Invalid: conversation without conversationId (must be dropped to null)
    notifications.notify({
      category: "coworker-finished",
      key: "coworker:source:missing",
      title: "Coworker missing convId",
      source: { target: "conversation" },
    });

    // Valid allowlisted target: routines with routineId
    notifications.notify({
      category: "routine-completed",
      key: "routine:source:1",
      title: "Routine with routineId",
      source: { target: "routines", routineId: "routine_456" },
    });

    // Invalid: routines without routineId (must be dropped to null)
    notifications.notify({
      category: "routine-completed",
      key: "routine:source:missing",
      title: "Routine missing routineId",
      source: { target: "routines" },
    });

    // Valid allowlisted target: triggers with triggerId
    notifications.notify({
      category: "trigger-fired",
      key: "trigger:source:1",
      title: "Trigger with triggerId",
      source: { target: "triggers", triggerId: "trig_789" },
    });

    // Target with authority and irrelevant fields (must strip everything except exact target field)
    notifications.notify({
      category: "trigger-fired",
      key: "trigger:source:3",
      title: "Trigger with dangerous fields",
      source: {
        target: "triggers",
        triggerId: "trig_999",
        routineId: "irrelevant_routine",
        conversationId: "irrelevant_conv",
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
    const attn = items.find((e) => e.title === "Attn with source");
    assert.deepEqual(attn.source, { target: "attention", jobId: "job_123" });

    const attnNoJob = items.find((e) => e.title === "Attn without jobId");
    assert.deepEqual(attnNoJob.source, { target: "attention" });

    const conv = items.find((e) => e.title === "Coworker with conversation");
    assert.deepEqual(conv.source, { target: "conversation", conversationId: "conv_abc" });

    const convMissing = items.find((e) => e.title === "Coworker missing convId");
    assert.equal(convMissing.source, null);

    const rout = items.find((e) => e.title === "Routine with routineId");
    assert.deepEqual(rout.source, { target: "routines", routineId: "routine_456" });

    const routMissing = items.find((e) => e.title === "Routine missing routineId");
    assert.equal(routMissing.source, null);

    const trig = items.find((e) => e.title === "Trigger with dangerous fields");
    assert.deepEqual(trig.source, { target: "triggers", triggerId: "trig_999" });
    assert.equal(trig.source.command, undefined);
    assert.equal(trig.source.cwd, undefined);
    assert.equal(trig.source.token, undefined);
    assert.equal(trig.source.url, undefined);
    assert.equal(trig.source.routineId, undefined);

    const invalid = items.find((e) => e.title === "Invalid target");
    assert.equal(invalid.source, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redaction canaries: secrets, tokens, cookies, and absolute paths are redacted from disk, public projection, and popups", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-redact-"));
  FakeNotification.reset();
  try {
    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    notifications.notify({
      category: "attention",
      key: "attn:redact:1",
      title: "File at C:\\Users\\SecretAdmin\\vault\\key.pem",
      body: "Check UNC \\\\server\\vault\\pass.txt and Authorization: Bearer sk-secret12345678901234567890 and Cookie: session_token=supersecret123",
    });

    notifications.notify({
      category: "coworker-finished",
      key: "coworker:redact:2",
      title: "Task in /home/deployer/.ssh/id_ed25519",
      body: "Worker returned api_key: gh_token_secret_123456789012345",
    });

    // 1. Check popup args: FakeNotification received redacted text
    assert.equal(FakeNotification.shown.length, 2);
    const popup1 = FakeNotification.shown[0];
    assert.ok(!popup1.title.includes("SecretAdmin"));
    assert.ok(popup1.title.includes("[REDACTED_PATH]"));
    assert.ok(!popup1.body.includes("server\\vault"));
    assert.ok(!popup1.body.includes("sk-secret"));
    assert.ok(!popup1.body.includes("supersecret"));
    assert.ok(popup1.body.includes("[REDACTED_PATH]"));
    assert.ok(popup1.body.includes("[REDACTED_TOKEN]"));

    const popup2 = FakeNotification.shown[1];
    assert.ok(!popup2.title.includes("/home/deployer"));
    assert.ok(popup2.title.includes("[REDACTED_PATH]"));
    assert.ok(!popup2.body.includes("gh_token_secret"));
    assert.ok(popup2.body.includes("[REDACTED_SECRET]"));

    // 2. Check public list projection
    const list = notifications.list().notifications;
    const item1 = list.find((e) => e.title.includes("[REDACTED_PATH]"));
    assert.ok(!item1.title.includes("C:\\"));
    assert.ok(!item1.body.includes("Bearer"));
    assert.ok(!item1.body.includes("session_token"));

    // 3. Check persisted JSON on disk
    const disk = JSON.parse(await readFile(join(root, "desktop-state", "notifications.json"), "utf8"));
    const diskStr = JSON.stringify(disk);
    assert.ok(!diskStr.includes("SecretAdmin"));
    assert.ok(!diskStr.includes("/home/deployer"));
    assert.ok(!diskStr.includes("sk-secret"));
    assert.ok(!diskStr.includes("supersecret"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed dates and opaque ID collision handling", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p17-corrupt-"));
  try {
    const stateDir = join(root, "desktop-state");
    await mkdir(stateDir, { recursive: true });
    // Write corrupted dates in legacy file
    const corrupted = {
      schema: "sovereignbot.desktop.notifications.v1",
      events: [
        { key: "c1", category: "attention", at: "completely-invalid-date-string" },
        { key: "c2", category: "trigger-fired", createdAt: null, at: "2026-09-02T12:00:00.000Z" },
      ],
    };
    await writeFile(join(stateDir, "notifications.json"), JSON.stringify(corrupted, null, 2), "utf8");

    const notifications = createNotificationService({
      dataDir: root,
      getSettings: () => ({ notifications: true }),
      NotificationClass: FakeNotification,
    });

    // Does not throw, sorts safely
    const list = notifications.list();
    assert.equal(list.totalCount, 2);
    assert.equal(list.notifications.length, 2);
    assert.match(list.notifications[0].id, /^notif_[a-f0-9]{16}$/);
    assert.match(list.notifications[1].id, /^notif_[a-f0-9]{16}$/);
    assert.notEqual(list.notifications[0].id, list.notifications[1].id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IPC channel registration and schema boundaries with tightened id validation", async () => {
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

  // Confirm validation logic and tightened opaque ID validator
  assert.match(ipcSource, /validateNotificationRequest/);
  assert.match(ipcSource, /NOTIFICATION_CATEGORIES_SET/);
  assert.match(ipcSource, /NOTIFICATION_OPAQUE_ID_PATTERN = \/\^notif_\[a-f0-9\]\{16\}\$\//);

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
