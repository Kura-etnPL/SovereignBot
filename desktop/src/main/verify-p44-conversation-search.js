// P44 hidden acceptance gate for full-history Conversation Search and anchored navigation.
// Uses only local fixture data and the real hidden Electron/preload/IPC/UI chain.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createConversationStore } from "./conversation-store.js";
import { createSearchService } from "./search-service.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), ".p44-evidence");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20_000) {
    const started = Date.now();
    while (Date.now() - started < timeout) { if (await check()) return; await sleep(100); }
    throw new Error(`timed out waiting for ${label}`);
}

export async function runVerifyP44ConversationSearch({ app } = {}) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const checks = {}; const notes = [];
    const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|storageRelativePath|sourceRelativePath|searchText|projectIds|provider|account|session|credential|token|secret|password|cookie|cwd|path)/gi, "[redacted]").slice(0, 1_500);
    const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail: safeJson(detail) } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${safeJson(detail)}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
    const result = { schema: "sovereignbot.desktop.p44-conversation-search-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
    let dataDir; let fixture; let win; let unbind; let uninstallProtocol;
    try {
        dataDir = mkdtempSync(join(tmpdir(), "sovereign-p44-data-"));
        fixture = makeFixture(dataDir);
        const team = fixture.teamService.createTeam({ title: "P44 History Search Team", coworkerIds: [fixture.chief.id, fixture.specialist.id], leadCoworkerId: fixture.chief.id });
        const conversationId = team.conversation.id;
        let targetMessage;
        for (let index = 0; index < 450; index += 1) {
            const message = fixture.conversationStore.postUserMessage(conversationId, { text: index === 7 ? "P44 ancient quartz needle" : `P44 retained history message ${index}` });
            if (index === 7) targetMessage = message;
        }
        const fixtureHandlers = handlers(fixture);
        uninstallProtocol = installAppProtocolHandler();
        win = createMainWindow({ smoke: true });
        unbind = bindIpcChannels({ win, handlers: fixtureHandlers });
        check("hidden Electron window stays hidden", win.isVisible() === false);
        await loadWindow(win);

        const initial = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P44 ancient quartz needle",types:["conversations"],status:"active",limit:10})`);
        const hit = initial.results?.[0];
        const publicJson = JSON.stringify(hit ?? {});
        check("Search finds the unique message outside the latest 100", initial.results?.length === 1 && hit?.id === conversationId && hit?.messageId === targetMessage.id, { total: initial.total, id: hit?.id, messageId: hit?.messageId, targetMessageId: targetMessage.id });
        check("public Conversation result is safe and bounded", hit?.type === "conversations" && hit?.matchSnippet?.length <= 180 && /quartz needle/i.test(hit.matchSnippet) && !/(searchText|messageText|projectIds|provider|session|credential|token|secret|password|cwd|path)/i.test(publicJson), { keys: Object.keys(hit ?? {}), snippetLength: hit?.matchSnippet?.length });
        check("indexed Search evaluates candidates instead of the full message corpus", fixture.search.diagnostics().candidateCount < fixture.search.diagnostics().corpusCount && fixture.search.diagnostics().matchEvaluations <= fixture.search.diagnostics().candidateCount, fixture.search.diagnostics());

        const anchored = await invoke(win, `async()=>window.sovereignbot.conversations.get({conversationId:${JSON.stringify(conversationId)},limit:100,aroundMessageId:${JSON.stringify(targetMessage.id)}})`);
        check("around-message page includes the target in a bounded page", anchored.messages?.length <= 100 && anchored.messages.some((message) => message.id === targetMessage.id), { count: anchored.messages?.length, targetMessageId: targetMessage.id });
        const foreignMessage = fixture.conversationStore.postUserMessage(fixture.teamService.createTeam({ title: "P44 Foreign", coworkerIds: [fixture.chief.id, fixture.specialist.id] }).conversation.id, { text: "P44 foreign anchor" });
        const anchorErrors = await invoke(win, `async()=>{const out={}; for (const [key, value] of Object.entries({foreign:${JSON.stringify(foreignMessage.id)},stale:"msg_deadbeefdeadbeef"})) { try { await window.sovereignbot.conversations.get({conversationId:${JSON.stringify(conversationId)},limit:100,aroundMessageId:value}); out[key]="accepted"; } catch (error) { out[key]=String(error?.message||error); } } return out}`);
        check("foreign and stale anchors fail closed", /invalid conversation anchor/i.test(anchorErrors.foreign) && /invalid conversation anchor/i.test(anchorErrors.stale), anchorErrors);

        await invoke(win, `async()=>{document.getElementById("open-command-palette")?.click(); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>!!document.querySelector("#command-palette:not(.hidden)")`)), "Search palette open");
        await invoke(win, `async()=>{const type=document.getElementById("palette-type-filter"); type.value="conversations"; type.dispatchEvent(new Event("change",{bubbles:true})); const input=document.querySelector("#command-palette input[type=search]"); input.value="P44 ancient quartz needle"; input.dispatchEvent(new Event("input",{bubbles:true})); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>document.querySelectorAll("#palette-results .command-palette-result").length`)) === 1, "historical Conversation Search result");
        await invoke(win, `async()=>{document.querySelector("#palette-results .command-palette-result")?.click(); return true}`);
        await waitFor(async () => (await invoke(win, `async()=>!!document.querySelector("[data-message-id=${JSON.stringify(targetMessage.id)}]")`)), "anchored historical message in the UI");
        const uiAnchor = await invoke(win, `async()=>{const target=document.querySelector("[data-message-id=${JSON.stringify(targetMessage.id)}]"); return {view:document.querySelector("#view-conversation")?.classList.contains("active"), rows:document.querySelectorAll("#conversation-messages [data-message-id]").length, highlighted:target?.classList.contains("conversation-message-highlight")===true||target?.getAttribute("aria-current")==="true", targetText:target?.textContent||""}}`);
        check("Search UI opens the conversation and highlights the historical message", uiAnchor.view && uiAnchor.rows <= 300 && uiAnchor.highlighted && /quartz needle/i.test(uiAnchor.targetText), uiAnchor);

        const fresh = fixture.conversationStore.postUserMessage(conversationId, { text: "P44 Fresh Tail Invalidation" });
        await waitFor(async () => (await invoke(win, `async()=>window.sovereignbot.search.query({query:"P44 Fresh Tail Invalidation",types:["conversations"],status:"active",limit:10})`)).results?.[0]?.messageId === fresh.id, "new message Search invalidation");
        const afterAppend = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P44 Fresh Tail Invalidation",types:["conversations"],status:"active",limit:10})`);
        check("new messages invalidate the historical Search index", afterAppend.results?.length === 1 && afterAppend.results[0].messageId === fresh.id, { id: afterAppend.results?.[0]?.id, messageId: afterAppend.results?.[0]?.messageId });

        const restartedStore = createConversationStore({ persistPath: join(dataDir, "desktop-state", "conversations.json"), coworkerStore: fixture.coworkerStore });
        fixture.conversationStore = restartedStore;
        fixture.search = createSearchService({ teamService: fixture.teamService, conversationStore: restartedStore, coworkerStore: fixture.coworkerStore, projectService: fixture.projectService, artifactStore: fixture.artifactStore, skillStore: fixture.skillStore, productSurfaces: fixture.productSurfaces, getRoutines: () => fixture.routines?.list?.(), memoryService: fixture.memoryService, getJobs: () => fixture.jobs, getHistory: () => ({ history: [] }) });
        restartedStore.onMessage(() => fixture.search?.invalidate());
        unbind?.();
        unbind = bindIpcChannels({ win, handlers: handlers(fixture) });
        await loadWindow(win);
        const afterRestart = await invoke(win, `async()=>window.sovereignbot.search.query({query:"P44 ancient quartz needle",types:["conversations"],status:"active",limit:10})`);
        check("restart rebuilds full-history Search from canonical storage", afterRestart.results?.[0]?.id === conversationId && afterRestart.results?.[0]?.messageId === targetMessage.id, { id: afterRestart.results?.[0]?.id, messageId: afterRestart.results?.[0]?.messageId });
    } catch (error) {
        result.error = safeJson(error?.stack ?? error); check("P44 hidden Conversation Search gate completed", false, error?.message ?? error);
    }
    result.ok = Object.values(checks).every((entry) => entry.ok);
    writeFileSync(join(EVIDENCE_DIR, "verify-p44-conversation-search.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writeFileSync(join(EVIDENCE_DIR, "verify-p44-conversation-search.log"), `${notes.join("\n")}\n`, "utf8");
    try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (!result.ok) { app?.exit(1); return; } app?.exit(0);
}
