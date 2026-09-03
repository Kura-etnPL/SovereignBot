// P33 hidden acceptance gate for the ordinary Search and Command Palette entry.
// It uses the real sandboxed preload, validated IPC, and canonical local stores.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createSearchService } from "./search-service.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const WORKTREE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(WORKTREE_ROOT, "_evidence_p33_2026-09-03");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await check()) return; await sleep(100); } throw new Error(`timed out waiting for ${label}`); }
const requiredTypes = ["conversations", "channels", "coworkers", "projects", "artifacts", "skills", "playbooks", "routines"];
const requiredCommands = ["New Coworker", "New Team", "New Channel", "Run Routine", "Teach Skill", "Open Computer", "Search"];
const forbidden = /(?:[A-Za-z]:[\\/]|workspacePath|rawPath|providerToken|credential|secret|password|cookie|bearer|sessionId|authority)/i;

export async function runVerifyP33SearchPalette({ app }) {
  mkdirSync(EVIDENCE_DIR, { recursive: true }); const checks = {}; const log = []; const note = (line) => { log.push(line); try { process.stderr.write(`${line}\n`); } catch {} }; const check = (name, ok, detail = "") => { checks[name] = Boolean(ok); note(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };
  let dataDir; let fixture; let win; let unbind; let uninstallProtocol; let fatal; let ids = {};
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p33-data-")); fixture = makeFixture(dataDir);
    const team = fixture.teamService.createTeam({ title: "P33 Search Team", coworkerIds: [fixture.chief.id, fixture.specialist.id], leadCoworkerId: fixture.chief.id }).team;
    ids.teamId = team.id; ids.channelId = team.channels?.[0]?.id; ids.conversationId = team.channels?.[0]?.conversationId;
    const project = await fixture.projectService.create({ name: "P33 Search Project" }); ids.projectId = project.projectId;
    const skill = fixture.skillStore.create({ name: "P33 Search Skill", description: "P33 search target", instructions: "Find the local target.", source: "manual" }); ids.skillId = skill.id;
    const playbook = fixture.productSurfaces.createPlaybook({ name: "P33 Search Playbook", description: "P33 search target", steps: ["chief"] }); ids.playbookId = playbook.id;
    const routine = fixture.routines.create({ name: "P33 Search Routine", coworkerId: fixture.chief.id, workspaceId: fixture.sharedWorkspaceId, instruction: "Inspect the P33 local search target.", schedule: { type: "custom", intervalMinutes: 60 } }); ids.routineId = routine.id;
    const workspacePath = fixture.services.workspacePath(fixture.sharedWorkspaceId); mkdirSync(join(workspacePath, "inbox"), { recursive: true }); writeFileSync(join(workspacePath, "inbox", "p33-search.md"), "P33 search artifact\n", "utf8");
    const artifact = fixture.artifactStore.ingestWorkspaceFile({ workspaceId: fixture.sharedWorkspaceId, workspacePath, relativePath: "inbox/p33-search.md", title: "P33 Search Artifact", createdByCoworkerId: fixture.chief.id, conversationId: ids.conversationId }); ids.artifactId = artifact.id;
    const appHandlers = { ...handlers(fixture), "conversation:createDirect": ({ coworkerId }) => fixture.conversationStore.createDirect(coworkerId), "playbook:export": ({ playbookId }) => fixture.productSurfaces.exportPlaybook(playbookId) };
    uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true }); unbind = bindIpcChannels({ win, handlers: appHandlers });
    check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);
    const surface = await invoke(win, `async()=>({ search:typeof window.sovereignbot?.search?.query, palette:typeof window.sovereignbot?.palette?.list, opener:!!document.getElementById("open-command-palette"), ready:document.readyState })`);
    check("ordinary entry exposes typed Search and Command Palette", surface.search === "function" && surface.palette === "function" && surface.opener && surface.ready === "complete", JSON.stringify(surface));
    await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); return true}`); await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 7, "seven palette commands");
    const commands = await invoke(win, `async()=>[...document.querySelectorAll("#palette-results .command-palette-result-title")].map((node)=>node.textContent)`);
    check("Command Palette lists the seven required actions", requiredCommands.every((label) => commands.includes(label)), JSON.stringify(commands));
    const summaries = [];
    for (const type of requiredTypes) {
      const expected = { conversations: ["P33 Search Team", ids.conversationId], channels: ["P33 Search Team", ids.channelId], coworkers: ["P15 Chief", fixture.chief.id], projects: ["P33 Search Project", ids.projectId], artifacts: ["P33 Search Artifact", ids.artifactId], skills: ["P33 Search Skill", ids.skillId], playbooks: ["P33 Search Playbook", ids.playbookId], routines: ["P33 Search Routine", ids.routineId] }[type];
      const response = await invoke(win, `async()=>window.sovereignbot.search.query({query:${JSON.stringify(expected[0])},types:[${JSON.stringify(type)}],status:"active",limit:10})`);
      const result = response.results?.[0]; summaries.push({ type, title: result?.title, id: result?.id, navigation: result?.navigation });
      check(`search discovers ${type} through the ordinary typed surface`, response.total >= 1 && result?.id === expected[1] && result?.action === "open" && !forbidden.test(JSON.stringify(result)), JSON.stringify({ total: response.total, result }));
    }
    check("search returns safe public summaries for all required types", summaries.length === 8 && summaries.every((entry) => entry.title && entry.navigation && !forbidden.test(JSON.stringify(entry))), JSON.stringify(summaries));
    await invoke(win, `async()=>{const input=document.querySelector("#command-palette input[type=search]"); const type=document.getElementById("palette-type-filter"); input.value="P33 Search Skill"; type.value="skills"; type.dispatchEvent(new Event("change",{bubbles:true})); input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
    await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 1, "skill search result"); await invoke(win, `async()=>{document.querySelector("#palette-results .command-palette-result")?.click(); return true}`); await waitFor(async () => await invoke(win, `async()=>document.getElementById("skill-dialog")?.open===true`), "exact Skill editor");
    const skillEditor = await invoke(win, `async()=>({ id:document.getElementById("skill-editor-id")?.value, name:document.getElementById("skill-editor-name")?.value })`); check("search result opens the exact Skill editor target", skillEditor.id === ids.skillId && skillEditor.name === "P33 Search Skill", JSON.stringify(skillEditor));
    await invoke(win, `async()=>{document.getElementById("skill-dialog")?.close(); return true}`);
    await invoke(win, `async()=>{const input=document.querySelector("#command-palette input[type=search]"); const type=document.getElementById("palette-type-filter"); input.value="no such P33 result"; type.value="all"; type.dispatchEvent(new Event("change",{bubbles:true})); input.dispatchEvent(new Event("input",{bubbles:true})); return true}`); await waitFor(async () => await invoke(win, `async()=>document.querySelector("#palette-results")?.innerText.includes("No matching visible results")`), "empty search state"); check("empty search state is honest", await invoke(win, `async()=>document.querySelector("#palette-results")?.innerText.includes("No matching visible results")`));
    const newSkill = fixture.skillStore.create({ name: "P33 Search After Invalidate", description: "visible after invalidation", instructions: "Refresh the local index.", source: "manual" }); fixture.search.invalidate(); const refreshed = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P33 Search After Invalidate",types:["skills"],status:"active",limit:10})`); check("index invalidation exposes a newly persisted local record", refreshed.results?.some((entry) => entry.id === newSkill.id));
    const restartedSearch = createSearchService({ teamService: fixture.teamService, conversationStore: fixture.conversationStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: fixture.artifactStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines.list(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: (payload) => fixture.productSurfaces.computerHistory(payload) });
    unbind(); unbind = bindIpcChannels({ win, handlers: { ...appHandlers, "search:query": (payload) => restartedSearch.query(payload) } }); await loadWindow(win); const afterRestart = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P33 Search Skill",types:["skills"],status:"active",limit:10})`); check("search index survives a real renderer and service restart", afterRestart.results?.some((entry) => entry.id === ids.skillId));
  } catch (error) { fatal = error; note(`[fatal] ${String(error?.stack ?? error)}`); check("P33 hidden gate runner completed", false, String(error?.message ?? error)); }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name); note(`[summary] ${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} PASS`); writeFileSync(join(EVIDENCE_DIR, "verify-p33-search-palette.json"), `${JSON.stringify({ at: new Date().toISOString(), publishEligible: false, checks, ids, fatal: fatal ? String(fatal?.message ?? fatal) : undefined }, null, 2)}\n`, "utf8"); writeFileSync(join(EVIDENCE_DIR, "verify-p33-search-palette.log"), `${log.join("\n")}\n`, "utf8"); try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {} if (fatal || failed.length) { app.exit(1); return; } app.exit(0);
}
