// P32 hidden acceptance gate for the independent Apps Catalog. It exercises
// the real hidden Electron window, sandboxed preload, validated IPC, and the
// local connected-apps service without starting a provider or network runtime.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createConnectedAppsService } from "./connected-apps.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), "..", "_evidence_p32_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeout = 15_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await check()) return;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

export async function runVerifyP32AppsCatalog({ app }) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {};
    const log = [];
    const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
    const forbidden = /providerToken|sessionId|rawPath|workspacePath|transport|schema|credential|secret|token/i;
    let dataDir;
    let fixture;
    let connectedApps;
    let win;
    let unbind;
    let uninstallProtocol;
    let fatal;
    try {
        dataDir = mkdtempSync(join(tmpdir(), "sovereign-p32-"));
        fixture = makeFixture(dataDir);
        const team = fixture.teamService.createTeam({ title: "P32 Catalog Team", coworkerIds: [fixture.chief.id, fixture.specialist.id], leadCoworkerId: fixture.chief.id }).team;
        connectedApps = fixture.connectedApps;
        await connectedApps.disconnect({ appId: "sovereignbot-computer" });
        const appHandlers = { ...handlers(fixture),
            "connectedApps:list": (payload) => connectedApps.list(payload),
            "connectedApps:search": (payload) => connectedApps.search(payload),
            "connectedApps:assign": (payload) => connectedApps.setAssignment(payload),
            "connectedApps:connect": (payload) => connectedApps.connect(payload),
            "connectedApps:disconnect": (payload) => connectedApps.disconnect(payload),
            "connectedApps:review": (payload) => connectedApps.review(payload),
            "connectedApps:disable": (payload) => connectedApps.disable(payload),
            "connectedApps:health": (payload) => connectedApps.health(payload),
        };
        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: appHandlers });
        check("hidden Electron window stays hidden", win.isVisible() === false);
        await loadWindow(win);

        const surface = await invoke(win, `async()=>({
            api: typeof window.sovereignbot?.connectedApps?.search === "function",
            nav: !!document.getElementById("nav-apps"),
            view: !!document.getElementById("view-apps"),
            search: !!document.getElementById("apps-catalog-search"),
            filters: !!document.getElementById("apps-catalog-category") && !!document.getElementById("apps-catalog-status") && !!document.getElementById("apps-catalog-project"),
            list: !!document.getElementById("apps-catalog-list"),
        })`);
        check("real preload exposes the independent Apps Catalog", surface.api && surface.nav && surface.view && surface.search && surface.filters && surface.list, JSON.stringify(surface));

        await invoke(win, `async()=>{document.getElementById("nav-apps")?.click(); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#apps-catalog-list .apps-catalog-card").length`)) >= 2, "catalog cards");
        let cards = await invoke(win, `async()=>[...document.querySelectorAll("#apps-catalog-list .apps-catalog-card")].map((card)=>card.innerText)`);
        check("Apps Catalog renders connection, health, capability, approval, and cost summaries", cards.length >= 2 && cards.every((body) => /Connection|Health|Capabilities|Approval|Cost/i.test(body)) && !cards.some((body) => forbidden.test(body)), JSON.stringify({ count: cards.length, sample: cards[0]?.slice(0, 500) }));

        await invoke(win, `async()=>{const input=document.getElementById("apps-catalog-search"); input.value="workspace"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#apps-catalog-list .apps-catalog-card").length`)) === 1, "catalog search result");
        const searched = await invoke(win, `async()=>document.querySelector("#apps-catalog-list .apps-catalog-card")?.innerText||""`);
        check("catalog search narrows to the matching app", /Project workspace/i.test(searched) && !/This PC/i.test(searched), searched.slice(0, 500));

        await invoke(win, `async()=>{document.getElementById("apps-catalog-search").value=""; document.getElementById("apps-catalog-status").value="unavailable"; document.getElementById("apps-catalog-status").dispatchEvent(new Event("change",{bubbles:true})); return true}`);
        await waitFor(async () => await invoke(win, `async()=>document.querySelector("#apps-catalog-list")?.innerText.includes("No apps match")`), "empty filtered state");
        check("status filtering has an honest empty state", await invoke(win, `async()=>document.querySelectorAll("#apps-catalog-list .apps-catalog-card").length`) === 0);

        await invoke(win, `async()=>{document.getElementById("apps-catalog-status").value=""; document.getElementById("apps-catalog-status").dispatchEvent(new Event("change",{bubbles:true})); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#apps-catalog-list .apps-catalog-card").length`)) >= 2, "catalog reset");
        const firstCard = `document.querySelector("#apps-catalog-list .apps-catalog-card")`;
        await invoke(win, `async()=>{${firstCard}?.querySelector("button")?.click(); return true}`);
        await waitFor(async () => await invoke(win, `async()=>document.querySelector("#apps-catalog-list .apps-catalog-review:not(.hidden)") !== null`), "connection review");
        const review = await invoke(win, `async()=>document.querySelector("#apps-catalog-list .apps-catalog-review")?.innerText||""`);
        check("connection review precedes the local connect action", /Review before connecting|Trusted source|Approval|Cost/i.test(review) && !forbidden.test(review), review.slice(0, 500));
        await invoke(win, `async()=>{const root=${firstCard}?.querySelector(".apps-catalog-review:not(.hidden)"); [...(root?.querySelectorAll("button")||[])].find((button)=>button.textContent.includes("Approve & connect"))?.click(); return true}`);
        await waitFor(async () => await invoke(win, `async()=>${firstCard}?.innerText.includes("Connected through the trusted App bridge.")`), "local connection state");
        check("Approve and connect reaches the real local connected state", await invoke(win, `async()=>${firstCard}?.innerText.includes("Disconnect") && ${firstCard}?.innerText.includes("Ready for governed task-bound use.")`));

        await invoke(win, `async()=>{const card=${firstCard}; const select=card?.querySelector('[aria-label^="Team assignment"]'); const option=[...(select?.options||[])].find((item)=>item.textContent.includes("P32 Catalog Team")); if(!option) throw new Error("P32 team option missing"); select.value=option.value; [...card.querySelectorAll("button")].find((button)=>button.textContent.includes("Assign Team"))?.click(); return true}`);
        await waitFor(async () => await invoke(win, `async()=>[...(${firstCard}?.querySelectorAll(".apps-catalog-assigned-row")||[])].some((row)=>row.innerText.includes("Team: P32 Catalog Team"))`), "Team assignment");
        const coworkerSetup = await invoke(win, `async()=>{const card=${firstCard}; const select=card?.querySelector('[aria-label^="Coworker assignment"]'); return { options:[...(select?.options||[])].map((option)=>({value:option.value,text:option.textContent})), buttons:[...card.querySelectorAll("button")].map((button)=>button.textContent) };}`);
        check("Apps Catalog loads Coworker assignment choices", coworkerSetup.options.some((option) => option.value === fixture.chief.id) && coworkerSetup.buttons.some((label) => label.includes("Assign Coworker")), JSON.stringify(coworkerSetup));
        await invoke(win, `async()=>{const card=${firstCard}; const select=card?.querySelector('[aria-label^="Coworker assignment"]'); if(!select) throw new Error("Coworker assignment control missing"); select.value=${JSON.stringify(fixture.chief.id)}; const button=[...card.querySelectorAll("button")].find((item)=>item.textContent.includes("Assign Coworker")); if(!button) throw new Error("Assign Coworker action missing"); button.click(); return { selected:select.value };}`);
        await waitFor(async () => await invoke(win, `async()=>[...(${firstCard}?.querySelectorAll(".apps-catalog-assigned-row")||[])].some((row)=>row.innerText.includes(${JSON.stringify(`Coworker: ${fixture.chief.name}`)}))`), "Coworker assignment");
        check("Apps Catalog assigns a Team and Coworker through opaque IDs", connectedApps.isAssigned({ appId: "sovereignbot-computer", teamId: team.id }) && connectedApps.isAssigned({ appId: "sovereignbot-computer", coworkerId: fixture.chief.id }));

        const teamRemoval = await invoke(win, `async()=>{const button=[...${firstCard}.querySelectorAll("button")].find((item)=>item.textContent.includes("Unassign Team")); button?.click(); return { found:Boolean(button), labels:[...${firstCard}.querySelectorAll("button")].map((item)=>item.textContent) };}`);
        check("Apps Catalog renders a Team unassignment action", teamRemoval.found, JSON.stringify(teamRemoval));
        await sleep(500);
        check("Team unassignment IPC removes the opaque assignment", !connectedApps.isAssigned({ appId: "sovereignbot-computer", teamId: team.id }));
        await waitFor(async () => await invoke(win, `async()=>![...(${firstCard}?.querySelectorAll(".apps-catalog-assigned-row")||[])].some((row)=>row.innerText.includes("Team: P32 Catalog Team"))`), "Team unassignment");
        await invoke(win, `async()=>{[...${firstCard}.querySelectorAll("button")].find((button)=>button.textContent.includes("Unassign Coworker"))?.click(); return true}`);
        await waitFor(async () => await invoke(win, `async()=>![...(${firstCard}?.querySelectorAll(".apps-catalog-assigned-row")||[])].some((row)=>row.innerText.includes(${JSON.stringify(`Coworker: ${fixture.chief.name}`)}))`), "Coworker unassignment");
        check("Apps Catalog unassigns Team and Coworker in the current scope", !connectedApps.isAssigned({ appId: "sovereignbot-computer", teamId: team.id }) && !connectedApps.isAssigned({ appId: "sovereignbot-computer", coworkerId: fixture.chief.id }));

        unbind?.();
        connectedApps = createConnectedAppsService({ dataDir, teamService: fixture.teamService, coworkerStore: fixture.coworkerStore, getProjectScope: (id) => fixture.projectService.resolveScope(id) });
        unbind = bindIpcChannels({ win, handlers: { ...appHandlers,
            "connectedApps:list": (payload) => connectedApps.list(payload), "connectedApps:search": (payload) => connectedApps.search(payload), "connectedApps:assign": (payload) => connectedApps.setAssignment(payload), "connectedApps:connect": (payload) => connectedApps.connect(payload), "connectedApps:disconnect": (payload) => connectedApps.disconnect(payload), "connectedApps:review": (payload) => connectedApps.review(payload), "connectedApps:disable": (payload) => connectedApps.disable(payload), "connectedApps:health": (payload) => connectedApps.health(payload),
        } });
        await loadWindow(win);
        const persisted = connectedApps.list({}).apps.find((entry) => entry.id === "sovereignbot-computer");
        check("connection and assignment state survives a real service restart", persisted?.connectionState === "connected" && persisted.assignedTeamIds.length === 0 && persisted.assignedCoworkerIds.length === 0, JSON.stringify(persisted));
    } catch (error) {
        fatal = error;
        note(`[fatal] ${String(error?.stack ?? error)}`);
        check("P32 hidden Apps Catalog gate runner completed", false, String(error?.message ?? error));
    }
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`);
    writeFileSync(join(EVIDENCE_DIR, "verify-p32-apps-catalog.json"), `${JSON.stringify({ at: new Date().toISOString(), publishEligible: false, checks, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p32-apps-catalog.log"), `${log.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (fatal || failed.length) { app.exit(1); return; }
    app.exit(0);
}
