import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createNotificationService } from "../src/main/notification-service.js";
import { createDesktopServices } from "../src/main/services.js";

test("settings expose a normal default model profile and category notification controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p6-settings-"));
  try {
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    assert.equal(services.getSettings().defaultModelProfile, "automatic");
    services.updateSettings({ defaultModelProfile: "deep", notificationPreferences: { attention: false } });
    const settings = services.getSettings();
    assert.equal(settings.defaultModelProfile, "deep");
    assert.equal(settings.notificationPreferences.attention, false);
    assert.equal(settings.notificationPreferences["coworker-finished"], true);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("local product notifications are allowlisted, configurable, and deduplicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p6-notify-"));
  const shown = [];
  class FakeNotification {
    static isSupported() { return true; }
    constructor(value) { this.value = value; }
    show() { shown.push(this.value); }
  }
  let settings = { notifications: true, notificationPreferences: { attention: true, "routine-completed": false, "trigger-fired": true, "coworker-finished": true, "channel-unread": true } };
  try {
    const service = createNotificationService({ dataDir: root, getSettings: () => settings, NotificationClass: FakeNotification });
    assert.deepEqual(service.notify({ category: "attention", key: "job:1:attention", title: "Attention needed", body: "Review required" }), { shown: true, deduplicated: false });
    assert.deepEqual(service.notify({ category: "attention", key: "job:1:attention", title: "Attention needed", body: "Review required" }), { shown: false, deduplicated: true });
    assert.deepEqual(service.notify({ category: "routine-completed", key: "routine:1", title: "Routine completed", body: "Done" }), { shown: false, deduplicated: false });
    assert.throws(() => service.notify({ category: "goal-completed", key: "goal:1", title: "No", body: "No" }), /unsupported notification category/);
    settings = { ...settings, notifications: false };
    assert.deepEqual(service.notify({ category: "channel-unread", key: "channel:1", title: "Unread", body: "New message" }), { shown: false, deduplicated: false });
    assert.equal(shown.length, 1);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("coworker registry supports a 50+ roster without creating active sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-p6-scale-"));
  try {
    const store = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    store.ensureDefaults();
    for (let i = 0; i < 61; i++) store.create({ name: `Scale ${i}`, role: "bounded support", instructions: "No automatic execution." });
    const roster = store.list({ includeArchived: true }).coworkers;
    assert.equal(roster.length, 64);
    assert.ok(roster.every((entry) => entry.state === "active" && !entry.sessionId));
    assert.throws(() => store.create({ name: "Overflow", role: "bounded support" }), /registry limit/);
  }
  finally { await rm(root, { recursive: true, force: true }); }
});
