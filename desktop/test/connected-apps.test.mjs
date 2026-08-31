import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConnectedAppsService } from "../src/main/connected-apps.js";
import { createConversationStore } from "../src/main/conversation-store.js";
import { createCoworkerStore } from "../src/main/coworker-store.js";
import { createDesktopServices } from "../src/main/services.js";
import { createTeamService } from "../src/main/team-service.js";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sovereign-connected-apps-"));
    const coworkers = createCoworkerStore({ persistPath: join(root, "coworkers.json") });
    const conversations = createConversationStore({ persistPath: join(root, "conversations.json"), coworkerStore: coworkers });
    const services = createDesktopServices({ dataDir: root, dialog: {} });
    const teams = createTeamService({ dataDir: root, coworkerStore: coworkers, conversationStore: conversations, services });
    const connectedApps = createConnectedAppsService({ dataDir: root, teamService: teams, coworkerStore: coworkers });
    return { root, coworkers, teams, connectedApps };
}

test("connected apps expose governed capabilities and persist opaque assignments", () => {
    const { root, coworkers, teams, connectedApps } = fixture();
    try {
        const installed = teams.installPack("software-team").team;
        const listed = connectedApps.list();
        assert.equal(listed.schema, "sovereignbot.desktop.connected-apps.v1");
        assert.deepEqual(listed.apps.map((entry) => entry.id), ["sovereignbot-computer", "sovereignbot-workspace"]);
        assert.ok(listed.apps.every((entry) => entry.authority === "Governor-controlled"));
        assert.equal(JSON.stringify(listed).includes("governedTools"), false);
        assert.equal(JSON.stringify(listed).includes("profileDir"), false);
        assert.equal(JSON.stringify(listed).includes("workspacePath"), false);

        const assignedToTeam = connectedApps.setAssignment({
            appId: "sovereignbot-computer",
            teamId: installed.id,
            enabled: true,
        });
        assert.deepEqual(assignedToTeam.assignedTeamIds, [installed.id]);
        assert.equal(connectedApps.isAssigned({ appId: "sovereignbot-computer", teamId: installed.id }), true);

        const codingLead = coworkers.list().coworkers.find((entry) => entry.name === "Coding Lead");
        const assignedToCoworker = connectedApps.setAssignment({
            appId: "sovereignbot-workspace",
            coworkerId: codingLead.id,
            enabled: true,
        });
        assert.deepEqual(assignedToCoworker.assignedCoworkerIds, [codingLead.id]);
        assert.equal(connectedApps.isAssigned({ appId: "sovereignbot-workspace", coworkerId: codingLead.id }), true);

        assert.throws(
            () => connectedApps.setAssignment({ appId: "sovereignbot-computer", teamId: installed.id, coworkerId: codingLead.id, enabled: true }),
            /exactly one/,
        );
        assert.throws(
            () => connectedApps.setAssignment({ appId: "sovereignbot-computer", teamId: "C:/private", enabled: true }),
            /opaque identifier/,
        );
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
