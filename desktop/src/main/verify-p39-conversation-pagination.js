// P39 hidden acceptance gate for bounded Conversation pagination. Uses only task-owned
// local fixtures, the real app protocol, sandboxed preload, validated IPC, and the
// canonical ConversationStore persistence path.
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeFixture, handlers, loadWindow, invoke } from "./verify-p15-project-command-center.js";
import { createConversationStore } from "./conversation-store.js";
import { createMainWindow } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const EVIDENCE_DIR = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR ?? join(process.cwd(), "..", "docs", "acceptance");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await check()) return; await sleep(100); } throw new Error(`timed out waiting for ${label}`); }

export async function runVerifyP39ConversationPagination({ app } = {}) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const checks = {}; const notes = [];
  const safeJson = (value) => JSON.stringify(value).replace(/(?:[A-Za-z]:[\\/]|file:\/\/|https?:\/\/|workspacePath|provider|session|credential|token|secret|password|cookie|cwd)/gi, "[redacted]");
  const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) }; const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`; notes.push(line); try { process.stderr.write(`${line}\n`); } catch {} };
  const result = { schema: "sovereignbot.desktop.p39-conversation-pagination-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [] };
  let dataDir; let fixture; let win; let unbind; let uninstallProtocol;
  try {
    dataDir = mkdtempSync(join(tmpdir(), "sovereign-p39-data-")); fixture = makeFixture(dataDir);
    const primary = fixture.teamService.createTeam({ title: "P39 Paging Team", coworkerIds: [fixture.chief.id, fixture.specialist.id] }).conversation;
    for (let index = 0; index < 450; index += 1) fixture.conversationStore.postUserMessage(primary.id, { text: `P39 message ${index}` });
    const secondary = fixture.teamService.createTeam({ title: "P39 Isolated Team", coworkerIds: [fixture.chief.id, fixture.specialist.id] }).conversation;
    fixture.conversationStore.postUserMessage(secondary.id, { text: "P39 second conversation one" });
    fixture.conversationStore.postUserMessage(secondary.id, { text: "P39 second conversation two" });
    const foreignCursor = fixture.conversationStore.get(secondary.id).messages[0].id;
    const baseHandlers = handlers(fixture);
    const pageHandlers = {
      ...baseHandlers,
      "conversation:get": ({ conversationId, limit, beforeMessageId }) => fixture.conversationStore.getPage(conversationId, { limit, beforeMessageId }),
      "conversation:send": ({ conversationId, text, mentions, replyTo, clientMessageId }) => fixture.conversationStore.postUserMessage(conversationId, { text, mentions, replyTo, clientMessageId }),
    };
    uninstallProtocol = installAppProtocolHandler(); win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: pageHandlers });
    check("hidden Electron window stays hidden", win.isVisible() === false); await loadWindow(win);
    const initial = await invoke(win, `async()=>window.sovereignbot.conversations.get({conversationId:${JSON.stringify(primary.id)}})`);
    check("default public conversation page is bounded", initial.messages?.length === 100 && initial.messageCount === 450 && initial.pageInfo?.hasOlder === true, safeJson({ count: initial.messages?.length, total: initial.messageCount, pageInfo: initial.pageInfo }));
    check("public conversation page strips internal fields", !/(workspacePath|provider|session|credential|token|secret|password|cookie|cwd)/i.test(JSON.stringify(initial)), safeJson({ keys: Object.keys(initial), messageKeys: Object.keys(initial.messages?.[0] ?? {}) }));
    await invoke(win, `async()=>{const button=[...document.querySelectorAll("#conversation-list button")].find((entry)=>entry.textContent.includes("${primary.title}")); button?.click(); return Boolean(button)}`);
    await waitFor(async () => await invoke(win, `async()=>document.getElementById("view-conversation")?.classList.contains("hidden")===false`), "primary conversation view");
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#conversation-messages [data-message-id]").length===100`), "bounded initial message DOM");
    const initialDom = await invoke(win, `async()=>({count:document.querySelectorAll("#conversation-messages [data-message-id]").length, first:document.querySelector("#conversation-messages [data-message-id] .chat-text")?.textContent||"", last:[...document.querySelectorAll("#conversation-messages [data-message-id] .chat-text")].at(-1)?.textContent||"", buttonHidden:document.getElementById("conversation-load-older")?.classList.contains("hidden")===true})`);
    check("initial Conversation DOM stays bounded", initialDom.count === 100 && initialDom.first === "P39 message 350" && initialDom.last === "P39 message 449" && !initialDom.buttonHidden, safeJson(initialDom));
    const captureAnchor = `async()=>{const scroller=document.getElementById("message-scroller"); const bounds=scroller.getBoundingClientRect(); const row=[...document.querySelectorAll("#conversation-messages [data-message-id]")].map((entry)=>({entry,rect:entry.getBoundingClientRect()})).find(({rect})=>rect.bottom>bounds.top+72&&rect.top<bounds.bottom-72); return row?{id:row.entry.dataset.messageId,offset:row.rect.top-bounds.top}:null}`;
    const loadOlderPage = async (expectedCount, expectedFirst, label) => {
      const before = await invoke(win, `async()=>{document.getElementById("message-scroller").scrollTop=Math.min(180,document.getElementById("message-scroller").scrollHeight); return (${captureAnchor})();}`);
      await invoke(win, `async()=>{document.getElementById("conversation-load-older")?.click(); return true}`);
      await waitFor(async () => await invoke(win, `async()=>{const button=document.getElementById("conversation-load-older"); const rows=[...document.querySelectorAll("#conversation-messages [data-message-id]")]; return button?.disabled===false && rows.length===${expectedCount} && rows[0]?.querySelector(".chat-text")?.textContent===${JSON.stringify(expectedFirst)}}`), label);
      await invoke(win, `async()=>new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const after = await invoke(win, captureAnchor);
      const anchorOk = Boolean(before && after && before.id === after.id && Math.abs(before.offset - after.offset) < 8);
      check(`Load older completes and preserves anchor: ${label}`, anchorOk, safeJson({ before, after }));
      return after;
    };
    await loadOlderPage(200, "P39 message 250", "older message page");
    await loadOlderPage(300, "P39 message 150", "second older message page");
    await loadOlderPage(300, "P39 message 50", "sliding historical window");
    const olderDom = await invoke(win, `async()=>{const scroller=document.getElementById("message-scroller"); const rows=[...document.querySelectorAll("#conversation-messages [data-message-id]")]; const ids=rows.map((row)=>row.dataset.messageId); return {count:rows.length,unique:new Set(ids).size,first:rows[0]?.querySelector(".chat-text")?.textContent||"",last:rows.at(-1)?.querySelector(".chat-text")?.textContent||"",top:scroller.scrollTop,height:scroller.scrollHeight,latestHidden:document.getElementById("conversation-latest-messages")?.classList.contains("hidden")===true,buttonHidden:document.getElementById("conversation-load-older")?.classList.contains("hidden")===true}}`);
    check("Load older slides a bounded ordered unique history window", olderDom.count === 300 && olderDom.unique === 300 && olderDom.first === "P39 message 50" && olderDom.last === "P39 message 349" && !olderDom.buttonHidden, safeJson(olderDom));
    const newMessage = fixture.conversationStore.postUserMessage(primary.id, { text: "P39 polled new message" });
    await waitFor(async () => await invoke(win, `async()=>{const button=document.getElementById("conversation-latest-messages"); return button && !button.classList.contains("hidden") && button.textContent.includes("1 new message")}`), "new message prompt while browsing history", 5_000);
    const afterPoll = await invoke(win, `async()=>({count:document.querySelectorAll("#conversation-messages [data-message-id]").length,first:document.querySelector("#conversation-messages [data-message-id] .chat-text")?.textContent||"",last:[...document.querySelectorAll("#conversation-messages [data-message-id] .chat-text")].at(-1)?.textContent||"",top:document.getElementById("message-scroller")?.scrollTop||0,height:document.getElementById("message-scroller")?.scrollHeight||0,latestText:document.getElementById("conversation-latest-messages")?.textContent||""})`);
    check("polling preserves the historical window and offers latest", afterPoll.count === 300 && afterPoll.first === "P39 message 50" && afterPoll.last === "P39 message 349" && afterPoll.latestText.includes("1 new message") && Math.abs((afterPoll.top - olderDom.top) - (afterPoll.height - olderDom.height)) < 8, safeJson(afterPoll));
    await invoke(win, `async()=>{document.getElementById("conversation-latest-messages")?.click(); return true}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#conversation-messages [data-message-id]").length===100 && [...document.querySelectorAll("#conversation-messages .chat-text")].at(-1)?.textContent==="${newMessage.text}"`), "back to latest", 5_000);
    const latestDom = await invoke(win, `async()=>({count:document.querySelectorAll("#conversation-messages [data-message-id]").length,first:document.querySelector("#conversation-messages [data-message-id] .chat-text")?.textContent||"",last:[...document.querySelectorAll("#conversation-messages [data-message-id] .chat-text")].at(-1)?.textContent||"",buttonHidden:document.getElementById("conversation-latest-messages")?.classList.contains("hidden")===true,top:document.getElementById("message-scroller")?.scrollTop||0,height:document.getElementById("message-scroller")?.scrollHeight||0})`);
    check("explicit Back to latest reloads the latest bounded page", latestDom.count === 100 && latestDom.first === "P39 message 351" && latestDom.last === newMessage.text && latestDom.buttonHidden && latestDom.top >= latestDom.height - 1000, safeJson(latestDom));
    await invoke(win, `async()=>{await refreshConversations(); const button=[...document.querySelectorAll("#conversation-list button")].find((entry)=>entry.textContent.includes("P39 Isolated Team")); button?.click(); return Boolean(button)}`);
    await waitFor(async () => await invoke(win, `async()=>document.querySelectorAll("#conversation-messages [data-message-id]").length===2`), "conversation switch");
    const switched = await invoke(win, `async()=>({count:document.querySelectorAll("#conversation-messages [data-message-id]").length,text:[...document.querySelectorAll("#conversation-messages .chat-text")].map((entry)=>entry.textContent),olderHidden:document.getElementById("conversation-load-older")?.classList.contains("hidden")===true})`);
    check("conversation switch isolates pagination state", switched.count === 2 && switched.text[0] === "P39 second conversation one" && switched.text[1] === "P39 second conversation two" && switched.olderHidden, safeJson(switched));
    const invalid = await invoke(win, `async()=>{const cases=[{conversationId:${JSON.stringify(primary.id)},limit:101},{conversationId:${JSON.stringify(primary.id)},unknown:true},{conversationId:${JSON.stringify(primary.id)},beforeMessageId:${JSON.stringify(foreignCursor)}}]; const out=[]; for(const payload of cases){try{await window.sovereignbot.conversations.get(payload); out.push(false)}catch(error){out.push(Boolean(error?.message))}} return out}`);
    check("pagination limit cursor and unknown fields fail closed", invalid.every(Boolean), safeJson({ rejected: invalid.filter(Boolean).length, total: invalid.length }));
    const restartedStore = createConversationStore({ persistPath: join(dataDir, "desktop-state", "conversations.json"), coworkerStore: fixture.coworkerStore });
    unbind?.(); unbind = bindIpcChannels({ win, handlers: { ...pageHandlers, "conversation:get": ({ conversationId, limit, beforeMessageId }) => restartedStore.getPage(conversationId, { limit, beforeMessageId }) } });
    await loadWindow(win);
    const afterRestart = await invoke(win, `async()=>window.sovereignbot.conversations.get({conversationId:${JSON.stringify(primary.id)}})`);
    check("restart rebuilds the same bounded page from persistence", afterRestart.messages?.length === 100 && afterRestart.messages.at(-1)?.text === newMessage.text && afterRestart.pageInfo?.total === 451, safeJson({ count: afterRestart.messages?.length, total: afterRestart.pageInfo?.total, lastId: afterRestart.messages?.at(-1)?.id }));
  } catch (error) { result.error = String(error?.stack ?? error).slice(0, 4000); check("P39 hidden Conversation gate completed", false, String(error?.message ?? error).slice(0, 500)); }
  result.ok = Object.values(checks).every((entry) => entry.ok); mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidencePath = join(EVIDENCE_DIR, "verify-p39-conversation-pagination.json");
  const logPath = join(EVIDENCE_DIR, "verify-p39-conversation-pagination.log");
  try { const { writeFileSync } = await import("node:fs"); writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8"); writeFileSync(logPath, `${notes.join("\n")}\n`, "utf8"); } catch {}
  try { unbind?.(); } catch {} try { uninstallProtocol?.(); } catch {} try { win?.destroy(); } catch {} try { if (dataDir) rmSync(dataDir, { recursive: true, force: true }); } catch {}
  app?.exit(result.ok ? 0 : 1);
}
