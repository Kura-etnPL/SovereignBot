// Hidden real-Electron gate for the Channels product lifecycle.
// It uses only isolated local TeamService/ConversationStore fixtures and the
// existing sandboxed preload + typed IPC surface.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationStore } from "./conversation-store.js";
import { createCoworkerStore } from "./coworker-store.js";
import { createDesktopServices } from "./services.js";
import { createTeamService } from "./team-service.js";
import { createMainWindow, appOrigin } from "./window.js";
import { installAppProtocolHandler } from "./protocol.js";
import { bindIpcChannels } from "./ipc.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidenceDir = process.env.SOVEREIGNBOT_PRODUCT_EVIDENCE_DIR;
const forbiddenPublicMarkers = ["session", "provider", "storageRelativePath", "sourceRelativePath", "access_token", "refresh_token"];

function makeFixture(dataDir) {
  const stateDir = join(dataDir, "desktop-state");
  return (async () => {
    await mkdir(stateDir, { recursive: true });
    const services = createDesktopServices({ dataDir, dialog: {} });
    const coworkers = createCoworkerStore({ persistPath: join(stateDir, "coworkers.json") });
    coworkers.ensureDefaults();
    const conversations = createConversationStore({ persistPath: join(stateDir, "conversations.json"), coworkerStore: coworkers });
    const teams = createTeamService({ dataDir, coworkerStore: coworkers, conversationStore: conversations, services });
    return { services, coworkers, conversations, teams };
  })();
}

function makeHandlers(fixture) {
  const { services, coworkers, conversations, teams } = fixture;
  const empty = (key) => () => ({ [key]: [] });
  return {
    "app:handshake": () => ({ ok: true, version: "4.0.0", platform: process.platform, locale: "en-US", language: "en" }),
    "firstrun:getStatus": () => ({ browsers: [], providers: {} }),
    "settings:get": () => services.getSettings(),
    "settings:update": (patch) => services.updateSettings(patch),
    "workspace:list": () => services.listWorkspaces(),
    "workspace:addViaDialog": () => ({ canceled: true }),
    "workspace:setDefault": () => ({ ok: true }),
    "workspace:remove": () => ({ removed: false }),
    "provider:getRoster": () => ({ ready: false, mode: "local-channel-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} }),
    "provider:refresh": () => ({ applied: false, roster: { ready: false, mode: "local-channel-gate", roles: {}, agents: [], providers: {}, coworkerBindings: {} } }),
    "provider:openLogin": () => ({ canceled: true }),
    "coworker:list": (payload) => coworkers.list(payload),
    "coworker:get": ({ coworkerId }) => coworkers.get(coworkerId),
    "conversation:list": () => conversations.list(),
    "conversation:get": ({ conversationId, limit, beforeMessageId, aroundMessageId }) => conversations.getPage(conversationId, { limit, beforeMessageId, aroundMessageId }),
    "conversation:acknowledge": ({ conversationId }) => ({ resolved: false, count: 0, conversationId }),
    "conversation:send": ({ conversationId, text, mentions, replyTo, clientMessageId }) => {
      if (teams.isArchivedConversation(conversationId)) throw new Error("archived channel is read-only");
      const message = conversations.postUserMessage(conversationId, { text, mentions, replyTo, clientMessageId });
      return { message, scheduledRecipients: 0 };
    },
    "team:list": () => teams.list(),
    "team:get": ({ teamId }) => teams.get(teamId),
    "team:activity": () => ({ events: [] }),
    "team:createChannelFromTemplate": ({ teamId, templateId }) => teams.createChannelFromTemplate(teamId, templateId),
    "channel:list": (payload) => teams.listChannels(payload),
    "channel:get": ({ channelId }) => teams.getChannel(channelId),
    "channel:create": (payload) => teams.createChannel(payload),
    "channel:update": ({ channelId, patch }) => teams.updateChannel(channelId, patch),
    "channel:archive": ({ channelId }) => teams.archiveChannel(channelId),
    "channel:restore": ({ channelId }) => teams.restoreChannel(channelId),
    "project:list": () => ({ projects: [] }),
    "connectedApps:list": () => ({ apps: [] }),
    "connectedApps:search": () => ({ apps: [] }),
    "connectedApps:health": () => ({ health: "unavailable" }),
    "skill:list": empty("skills"),
    "playbook:list": empty("playbooks"),
    "artifact:list": empty("artifacts"),
    "artifact:hub": empty("artifacts"),
    "computer:history": empty("history"),
    "eventTrigger:list": empty("triggers"),
    "notification:list": () => ({ notifications: [], totalCount: 0, unreadCount: 0 }),
    "data:status": () => ({ stateVersion: 1, backups: [] }),
    "data:listBackups": empty("backups"),
    "memory:list": () => ({ memories: [], suggestions: [] }),
    "memory:listSuggestions": empty("suggestions"),
    "job:list": empty("jobs"),
    "job:attention": empty("jobs"),
    "routine:list": empty("routines"),
    "update:status": () => ({ available: false, currentVersion: "4.0.0", channel: "stable" }),
  };
}

async function invoke(win, expression) { return win.webContents.executeJavaScript(`(${expression})()`); }

async function waitFor(win, expression, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await invoke(win, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function loadChannels(win) {
  await win.loadURL(appOrigin());
  await sleep(900);
  await invoke(win, "async()=>{ document.getElementById('nav-channels')?.click(); return true; }");
  await waitFor(win, "async()=>!document.getElementById('view-channels')?.classList.contains('hidden') && document.getElementById('product-channel-template-team-page')?.options.length > 0", "Channels page");
}

async function captureChannelsDiagnostics(win, fixture, channel) {
  const conversations = fixture?.conversations?.list?.().conversations ?? [];
  const conversation = conversations.find((entry) => entry.id === channel?.conversationId);
  const fixtureSnapshot = conversation ? {
    title: conversation.title,
    messageCount: conversation.messageCount,
    updatedAt: conversation.updatedAt,
    lastMessage: conversation.lastMessage ? {
      senderId: conversation.lastMessage.senderId,
      createdAt: conversation.lastMessage.createdAt,
      textPreview: conversation.lastMessage.textPreview,
    } : undefined,
  } : undefined;
  const readMarkerSnapshot = await invoke(win, `async()=>{ try { const parsed=JSON.parse(localStorage.getItem('sovereignbot.conversation-read-v1')||'{}'); return { markerPresent:Boolean(parsed[${JSON.stringify(channel?.conversationId ?? "")}]), markerCount:Object.keys(parsed).length }; } catch(error) { return { error:String(error?.message||error) }; } }`).catch((error) => ({ error: String(error?.message ?? error) }));
  const rendererSnapshot = () => invoke(win, `async()=>({ filter:document.getElementById('product-channel-filter-page')?.value||'', conversationTitle:document.getElementById('conversation-title')?.textContent||'', pageText:document.getElementById('product-channels-page')?.innerText||'', cards:[...document.querySelectorAll('#product-channels-page article')].map((card)=>card.innerText), switchValue:document.getElementById('product-channel-switch-page')?.value||'', switchOptions:[...document.getElementById('product-channel-switch-page')?.options||[]].map((option)=>({value:option.value,text:option.textContent})) })`);
  const before = await rendererSnapshot().catch((error) => ({ error: String(error?.message ?? error) }));
  let explicitRefresh;
  try {
    explicitRefresh = await invoke(win, "async()=>{ if(typeof window.refreshIndependentProductPages!=='function') return { available:false }; await window.refreshIndependentProductPages(); return { available:true }; }");
  } catch (error) {
    explicitRefresh = { available: true, error: String(error?.message ?? error) };
  }
  const after = await rendererSnapshot().catch((error) => ({ error: String(error?.message ?? error) }));
  return { fixture: fixtureSnapshot, readMarkers: readMarkerSnapshot, before, explicitRefresh, after };
}

export async function runVerifyChannelsProductPath({ app } = {}) {
  const checks = {};
  const notes = [];
  const check = (name, ok, detail = "") => { checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) }; notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); try { process.stdout.write(`${notes.at(-1)}\n`); } catch {} };
  let dataDir;
  let fixture;
  let win;
  let targetChannel;
  let unbind;
  let uninstallProtocol;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "sovereign-channels-"));
    fixture = await makeFixture(dataDir);
    const installed = fixture.teams.installPack("software-team");
    const team = installed.team;
    const owner = fixture.coworkers.list({}).coworkers[0];
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: makeHandlers(fixture) });
    check("hidden Electron window stays hidden", win.isVisible() === false);
    await loadChannels(win);

    const initial = await invoke(win, "async()=>({ view:!document.getElementById('view-channels')?.classList.contains('hidden'), team:document.getElementById('product-channel-template-team-page')?.value||'', templates:[...document.getElementById('product-channel-template-page')?.options||[]].map((entry)=>entry.value), text:document.getElementById('product-channels-page')?.innerText||'' })");
    check("Channels page exposes team, template, filter, and quick-switch controls", initial.view && initial.team === team.id && initial.templates.includes("work") && initial.text.includes("Project Channel"), JSON.stringify(initial));

    await invoke(win, `async()=>{ const team=document.getElementById('product-channel-template-team-page'); const template=document.getElementById('product-channel-template-page'); team.value=${JSON.stringify(team.id)}; template.value='work'; document.getElementById('product-channel-template-add-page')?.click(); return true; }`);
    await waitFor(win, `async()=>document.getElementById('product-channels-page')?.innerText.includes('Work Channel')`, "template-created channel");
    let catalog = await fixture.teams.listChannels({ teamId: team.id, includeArchived: true });
    const workChannel = catalog.channels.find((entry) => entry.name === "Work Channel");
    targetChannel = workChannel;
    const templateCreated = await invoke(win, `async()=>({ card:document.getElementById('product-channels-page')?.innerText.includes('Work Channel'), hiddenId:document.getElementById('product-channels-page')?.innerText.includes(${JSON.stringify(workChannel.id)}), templateValue:document.getElementById('product-channel-template-page')?.value||'' })`);
    check("From template creates a real channel through the product page", Boolean(workChannel?.id) && templateCreated.card && !templateCreated.hiddenId && templateCreated.templateValue === "work", JSON.stringify(templateCreated));

    const projectChannel = team.channels.find((entry) => entry.name === "Project Channel");
    await invoke(win, "async()=>{ const card=[...document.querySelectorAll('#product-channels-page article')].find((entry)=>entry.querySelector('h3')?.textContent==='Project Channel'); [...card?.querySelectorAll('button')||[]].find((button)=>button.textContent.includes('Open'))?.click(); return Boolean(card); }");
    await waitFor(win, "async()=>document.getElementById('conversation-title')?.textContent==='Project Channel'", "neutral conversation before unread fixture");
    await invoke(win, "async()=>{ document.getElementById('nav-channels')?.click(); return true; }");
    await waitFor(win, "async()=>!document.getElementById('view-channels')?.classList.contains('hidden') && document.getElementById('product-channels-page')?.innerText.includes('Work Channel')", "Channels page after neutral conversation");
    check("Unread fixture starts outside the target conversation", projectChannel?.conversationId !== workChannel.conversationId, JSON.stringify({ selectedConversation: projectChannel?.name ?? null }));

    fixture.conversations.postCoworkerMessage(workChannel.conversationId, owner.id, { text: "Unread channel activity fixture" }, { notifyChannelUnread: false });
    await invoke(win, "async()=>{ const filter=document.getElementById('product-channel-filter-page'); filter.value='unread'; filter.dispatchEvent(new Event('change',{bubbles:true})); return true; }");
    await waitFor(win, "async()=>{ const text=(document.getElementById('product-channels-page')?.innerText||'').toLocaleLowerCase(); return text.includes('unread / 未读') && text.includes('unread channel activity fixture'); }", "unread channel projection");
    const unread = await invoke(win, "async()=>document.getElementById('product-channels-page')?.innerText||''");
    const unreadText = unread.toLocaleLowerCase();
    check("Unread filter and last activity are visible for the created channel", unread.includes("Work Channel") && unreadText.includes("unread / 未读") && unreadText.includes("unread channel activity fixture"), JSON.stringify({ text: unread }));

    const quickSwitch = await invoke(win, "async()=>{ const select=document.getElementById('product-channel-switch-page'); const option=[...select.options].find((entry)=>entry.textContent.includes('Work Channel')); if(!option) return { value:'' }; select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return { value:option.value, visible:option.textContent }; }");
    await waitFor(win, `async()=>document.getElementById('conversation-title')?.textContent==='Work Channel'`, "quick switch conversation");
    check("Quick switch opens the selected channel conversation", quickSwitch.value === workChannel.conversationId && !quickSwitch.visible.includes(workChannel.conversationId), JSON.stringify(quickSwitch));

    await invoke(win, "async()=>{ document.getElementById('nav-channels')?.click(); return true; }");
    await waitFor(win, "async()=>document.getElementById('product-channels-page')?.innerText.includes('Work Channel')", "active Channels page");
    await invoke(win, `async()=>{ const card=[...document.querySelectorAll('#product-channels-page article')].find((entry)=>entry.querySelector('h3')?.textContent==='Work Channel'); [...card?.querySelectorAll('button')||[]].find((button)=>button.textContent.includes('Archive'))?.click(); return Boolean(card); }`);
    await waitFor(win, `async()=>{ const listed=await window.sovereignbot.channels.list({teamId:${JSON.stringify(team.id)},includeArchived:true}); return listed.channels.some((entry)=>entry.id===${JSON.stringify(workChannel.id)}&&entry.archived===true); }`, "archived channel state");
    catalog = await fixture.teams.listChannels({ teamId: team.id, includeArchived: true });
    const activeCatalog = await fixture.teams.listChannels({ teamId: team.id, includeArchived: false });
    check("Archive click persists and includeArchived remains explicit", catalog.channels.some((entry) => entry.id === workChannel.id && entry.archived) && !activeCatalog.channels.some((entry) => entry.id === workChannel.id), JSON.stringify({ all: catalog.channels.length, active: activeCatalog.channels.length }));
    const archivedSend = await invoke(win, `async()=>{ try { await window.sovereignbot.conversations.send({conversationId:${JSON.stringify(workChannel.conversationId)},text:'must be rejected'}); return false; } catch(error) { return String(error?.message||error); } }`);
    const staleArchive = await invoke(win, `async()=>{ try { await window.sovereignbot.channels.archive({channelId:${JSON.stringify(`${workChannel.id}-stale` )}}); return false; } catch(error) { return String(error?.message||error); } }`);
    check("Archived and stale channel actions fail closed", String(archivedSend).includes("archived channel is read-only") && Boolean(staleArchive), JSON.stringify({ archivedSend, staleArchive }));

    await invoke(win, "async()=>{ const filter=document.getElementById('product-channel-filter-page'); filter.value='archived'; filter.dispatchEvent(new Event('change',{bubbles:true})); return true; }");
    await waitFor(win, "async()=>document.getElementById('product-channels-page')?.innerText.includes('Read-only / 只读')", "archived channel page");
    const archivedUi = await invoke(win, "async()=>({ text:document.getElementById('product-channels-page')?.innerText||'', restore:[...document.querySelectorAll('#product-channels-page article button')].some((button)=>button.textContent.includes('Restore')) })");
    check("Archived filter renders read-only channel with Restore action", archivedUi.text.includes("Work Channel") && archivedUi.text.includes("Read-only / 只读") && archivedUi.restore, JSON.stringify({ restore: archivedUi.restore }));

    unbind?.(); unbind = undefined; win.destroy(); win = undefined; uninstallProtocol?.(); uninstallProtocol = undefined;
    fixture = await makeFixture(dataDir);
    const persisted = (await fixture.teams.listChannels({ teamId: team.id, includeArchived: true })).channels.find((entry) => entry.id === workChannel.id);
    check("Archived state survives service recreation", persisted?.archived === true, JSON.stringify({ archived: persisted?.archived ?? null }));
    uninstallProtocol = installAppProtocolHandler();
    win = createMainWindow({ smoke: true });
    unbind = bindIpcChannels({ win, handlers: makeHandlers(fixture) });
    await loadChannels(win);
    await invoke(win, "async()=>{ const filter=document.getElementById('product-channel-filter-page'); filter.value='archived'; filter.dispatchEvent(new Event('change',{bubbles:true})); return true; }");
    await waitFor(win, "async()=>document.getElementById('product-channels-page')?.innerText.includes('Work Channel') && document.getElementById('product-channels-page')?.innerText.includes('Read-only / 只读')", "reloaded archived channel");
    const publicText = await invoke(win, "async()=>document.getElementById('view-channels')?.innerText||''");
    check("Reloaded Channels page preserves safe public projection", publicText.includes("Work Channel") && !publicText.includes(workChannel.id) && !forbiddenPublicMarkers.some((marker) => publicText.toLowerCase().includes(marker.toLowerCase())) && !publicText.includes(dataDir), JSON.stringify({ bytes: publicText.length }));
    await invoke(win, "async()=>{ const filter=document.getElementById('product-channel-filter-page'); filter.value='all'; filter.dispatchEvent(new Event('change',{bubbles:true})); return true; }");
    await waitFor(win, "async()=>document.getElementById('product-channels-page')?.innerText.includes('Restore')", "restore action after reload");
    await invoke(win, `async()=>{ const card=[...document.querySelectorAll('#product-channels-page article')].find((entry)=>entry.querySelector('h3')?.textContent==='Work Channel'); [...card?.querySelectorAll('button')||[]].find((button)=>button.textContent.includes('Restore'))?.click(); return true; }`);
    await waitFor(win, `async()=>{ const listed=await window.sovereignbot.channels.list({teamId:${JSON.stringify(team.id)},includeArchived:true}); return listed.channels.some((entry)=>entry.id===${JSON.stringify(workChannel.id)}&&entry.archived===false); }`, "restored channel state");
    check("Restore click re-enables the channel", (await fixture.teams.listChannels({ teamId: team.id, includeArchived: false })).channels.some((entry) => entry.id === workChannel.id), "Work Channel active");
  } catch (error) {
    let detail = String(error?.message ?? error).slice(0, 700);
    if (win && targetChannel) {
      try { detail += ` diagnostics=${JSON.stringify(await captureChannelsDiagnostics(win, fixture, targetChannel)).slice(0, 6_000)}`; } catch (diagnosticError) { detail += ` diagnosticsError=${String(diagnosticError?.message ?? diagnosticError).slice(0, 500)}`; }
    }
    check("Channels product hidden gate completed", false, detail);
  } finally {
    try { unbind?.(); } catch {}
    try { uninstallProtocol?.(); } catch {}
    try { win?.destroy(); } catch {}
    try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch {}
  }
  const result = { schema: "sovereignbot.desktop.channels-product-path-canary.v1", fixtureBoundary: "LOCAL_FIXTURE", publishEligible: false, checks, notes, externalActions: [], ok: Object.values(checks).every((entry) => entry.ok) };
  if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, "verify-channels-product-path.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"); await writeFile(join(evidenceDir, "verify-channels-product-path.log"), `${notes.join("\n")}\n`, "utf8"); }
  if (!result.ok) throw new Error(`Channels product gate failed: ${Object.entries(checks).filter(([, entry]) => !entry.ok).map(([name]) => name).join(", ")}`);
  app?.exit?.(0);
  return result;
}
