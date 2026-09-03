import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const html = read("../ui/index.html");
const app = read("../ui/app.js");
const voice = read("../ui/voice-controller.js");
const productHubs = read("../ui/product-hubs-ui.js");
const thisPcUi = read("../ui/this-pc-ui.js");
const appsCatalog = read("../ui/apps-catalog-ui.js");
const memoryUi = read("../ui/memory-ui.js");
const paletteUi = read("../ui/search-palette-ui.js");
const jobsUi = read("../ui/jobs-ui.js");
const css = read("../ui/style.css");

test("V3 default shell is coworker-first rather than Goal/Control-Center-first", () => {
    assert.match(html, /SOVEREIGN COWORKER OS/);
    assert.match(html, /id="coworker-list"/);
    assert.match(html, /id="team-list"/);
    assert.match(html, /id="conversation-messages"/);
    assert.match(html, /id="composer-form"/);
    assert.match(html, /id="voice-input"/);
    assert.match(html, /id="details-panel"/);
    assert.doesNotMatch(html, /id="goal-form"/);
    assert.doesNotMatch(html, />Run goal</);
    assert.doesNotMatch(html, />Planner</);
    assert.doesNotMatch(html, />Worker</);
    assert.doesNotMatch(html, />Synthesizer</);
});

test("V3 renderer consumes typed coworker/conversation APIs and never uses HTML injection", () => {
    for (const expression of [
        /sovereignbot\.coworkers\.list/,
        /sovereignbot\.coworkers\.create/,
        /sovereignbot\.conversations\.createDirect/,
        /sovereignbot\.conversations\.createTeam/,
        /sovereignbot\.conversations\.send/,
        /sovereignbot\.conversations\.get/,
        /sovereignbot\.teams\.activity/,
    ]) assert.match(app, expression);
    assert.doesNotMatch(app, /innerHTML\s*=/);
    assert.doesNotMatch(app, /insertAdjacentHTML/);
    assert.doesNotMatch(app, /eval\s*\(/);
    assert.doesNotMatch(app, /new Function/);
});

test("V3 conversation UX supports durable polling, team mentions, details and provider readiness", () => {
    assert.match(app, /setTimeout\(\(\) => refreshConversation\(false\), 850\)/);
    assert.match(app, /conversations\.get\(\{ conversationId: id, limit: CONVERSATION_PAGE_SIZE \}\)/);
    assert.match(app, /loadOlderMessages/);
    assert.match(app, /MAX_RENDERED_MESSAGES = 300/);
    assert.match(app, /historyMode/);
    assert.match(app, /jumpToLatestMessages/);
    assert.match(app, /@everyone/);
    assert.match(app, /state\.mentionIds/);
    assert.match(app, /pendingUserRecipients/);
    assert.match(app, /coworkerBindings/);
    assert.match(html, /id="conversation-presence"/);
    assert.match(html, /id="conversation-load-older"/);
    assert.match(html, /id="conversation-latest-messages"/);
    assert.match(html, /id="conversation-page-status"/);
    assert.match(html, /id="mention-row"/);
    assert.match(html, /id="provider-cards"/);
    assert.match(voice, /SpeechRecognition/);
    assert.match(app, /speechSynthesis/);
});

test("Coworker details expose safe editing and availability controls", () => {
    assert.match(html, /id="coworker-dialog"/);
    assert.match(html, /id="coworker-state"/);
    assert.match(app, /openCoworkerDialog/);
    assert.match(app, /sovereignbot\.coworkers\.update/);
    assert.match(app, /Existing provider\/account\/model binding is preserved/);
});

test("V3 shell carries a coherent responsive design system rather than legacy admin panels", () => {
    for (const token of ["--sidebar", "--details", "--panel", "--text", "--good", "--warn"]) assert.ok(css.includes(token), token);
    assert.match(css, /\.app-shell/);
    assert.match(css, /\.conversation-view/);
    assert.match(css, /\.chat-messages/);
    assert.match(css, /\.composer-shell/);
    assert.match(css, /\.details-panel/);
    assert.match(css, /\.settings-grid/);
    assert.match(css, /@media \(max-width: 980px\)/);
});

test("Product hubs expose governed Connected Apps assignment without raw authority", () => {
    assert.match(productHubs, /product-connected-apps/);
    assert.match(productHubs, /connectedApps\.list/);
    assert.match(productHubs, /connectedApps\.assign/);
    assert.match(productHubs, /appId: item\.id/);
    assert.doesNotMatch(productHubs, /providerToken|sessionId|rawPath|capabilityGrant/);
});

test("Projects create uses a bounded form rather than a blocking browser prompt", () => {
    assert.match(html, /id="project-create-dialog"/);
    assert.match(html, /id="project-create-form"/);
    assert.match(productHubs, /project-create-form/);
    assert.match(productHubs, /project-create-form-error/);
    assert.match(productHubs, /exportViaDialog/);
    assert.doesNotMatch(productHubs, /window\.prompt\("Project name/);
});

test("Command Palette Run Routine uses a bounded selector instead of a prompt picker", () => {
    for (const id of ["routine-run-dialog", "routine-run-form", "routine-run-search", "routine-run-list", "routine-run-confirm"]) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(paletteUi, /api\.routines\.list\(\{ includeArchived: true \}\)/);
    assert.match(paletteUi, /api\.palette\.execute\(\{ paletteId: "run-routine"/);
    assert.doesNotMatch(paletteUi, /window\.prompt/);
    assert.doesNotMatch(paletteUi, /window\.alert/);
});

test("Global Search result navigation opens the exact ordinary target", () => {
    for (const expression of [/nav\.coworkerId.*openDirect/, /open-skill-editor/, /open-playbook-editor/, /open-routine/, /nav\.skillId/, /nav\.playbookId/, /nav\.routineId/]) assert.match(paletteUi, expression);
    assert.match(paletteUi, /item\.matchReason\?\.key/);
    assert.match(paletteUi, /MATCH_REASON_LABELS/);
    assert.doesNotMatch(paletteUi, /item\.searchText/);
});

test("Routine cards keep Run now and Restore feedback in-product and guard pending actions", () => {
    assert.match(jobsUi, /routineActionPending/);
    assert.match(jobsUi, /routineActionFeedback/);
    assert.match(jobsUi, /runRoutineFromCard/);
    assert.match(jobsUi, /restoreRoutineFromCard/);
    assert.match(jobsUi, /routine-action-dismiss/);
    assert.match(jobsUi, /routine\.canRun !== true/);
    assert.match(jobsUi, /window\.sovereignbot\.routines\.runNow\(\{ routineId \}\)/);
    assert.match(jobsUi, /window\.sovereignbot\.routines\.restore\(\{ routineId \}\)/);
    assert.doesNotMatch(jobsUi, /window\.alert/);
    assert.doesNotMatch(jobsUi, /window\.prompt/);
    assert.doesNotMatch(jobsUi, /window\.confirm/);
});

test("Apps Catalog is an independent user surface with honest lifecycle review", () => {
    for (const id of ["nav-apps", "view-apps", "apps-catalog-search", "apps-catalog-category", "apps-catalog-status", "apps-catalog-project", "apps-catalog-list"]) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const expression of [/connectedApps\.search/, /connectedApps\.review/, /connectedApps\.connect/, /connectedApps\.disconnect/, /connectedApps\.disable/, /Assign Team/, /Assign Coworker/, /Unassign \$\{kind\}/, /enabled: false/, /trustedSource/, /installationState/, /metered/]) assert.match(appsCatalog, expression);
    assert.match(appsCatalog, /Review before connecting/);
    assert.doesNotMatch(appsCatalog, /providerToken|sessionId|rawPath|workspacePath|adapter|transport|credential/);
    assert.match(css, /\.apps-catalog-card/);
});

test("Memory is a first-class scoped surface with safe source actions", () => {
    for (const id of ["nav-memory", "view-memory", "memory-scope", "memory-owner", "memory-state", "memory-search", "memory-list", "memory-suggestions"]) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const expression of [/memory\.list/, /memory\.update/, /memory\.forget/, /memory\.delete/, /memory\.pin/, /memory\.sourceTrace/, /approveSuggestion/, /rejectSuggestion/, /sovereignbot:open-memory/]) assert.match(memoryUi, expression);
    assert.match(app, /project\?\.projectId/);
    assert.doesNotMatch(app, /const projectId = team\?\.id/);
    assert.doesNotMatch(memoryUi, /workspacePath|providerToken|sessionId|rawPath/);
});

test("Worker Nodes copy matches the authenticated pairing surface", () => {
    assert.match(html, /Loopback discovery or authenticated LAN pairing/);
    assert.match(html, /Remote controller relay pairing is managed separately below/);
    assert.doesNotMatch(html, /Loopback only in V4\.5|Remote-network pairing is not enabled/);
});

test("Team activity consumes the safe collaboration ledger projection", () => {
    assert.match(productHubs, /flow\?\.activity/);
    assert.match(productHubs, /Owner/);
    assert.match(productHubs, /Stage/);
    assert.match(productHubs, /Handoff to/);
    assert.doesNotMatch(productHubs, /cwd|sessionId|providerToken|workspacePath/);
});

test("Product burst exposes independent Playbooks, Artifacts, History, Skills, Packs, and Channels pages", () => {
    for (const id of [
        "view-playbooks",
        "view-artifacts",
        "view-computer-history",
        "view-skills",
        "view-team-packs",
        "view-channels",
        "product-playbooks-page",
        "artifact-hub-filter-page",
        "artifact-hub-type-page",
        "computer-history-filter-page",
        "product-artifacts-deeplink-status",
        "product-computer-history-deeplink-status",
        "product-skills-page",
        "product-packs-page",
        "product-channels-page",
        "team-pack-editor-dialog",
        "team-pack-editor-form",
        "team-pack-editor-coworkers",
        "team-pack-editor-channels",
        "team-pack-editor-playbooks",
        "team-pack-editor-add-coworker",
        "team-pack-editor-add-channel",
        "team-pack-editor-add-playbook",
        "playbook-dialog",
        "playbook-form",
        "playbook-editor-steps",
        "playbook-editor-stages",
        "playbook-editor-reviews",
        "playbook-editor-add-step",
        "playbook-editor-add-stage",
        "playbook-editor-add-review",
        "playbook-file-result",
        "skill-dialog",
        "skill-form",
        "skill-editor-inputs",
        "skill-editor-steps",
        "skill-editor-validators",
        "skill-editor-add-input",
        "skill-editor-add-step",
        "skill-editor-add-validator",
    ]) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const expression of [
        /playbooks\.duplicate/,
        /playbooks\.assign/,
        /playbookSemanticPlan/,
        /reviewPoints/,
        /Recommended Skills/,
        /artifacts\.hub/,
        /History \/ 历史/,
        /Go to conversation \/ 前往会话/,
        /computer\.history/,
        /artifactScopeOverride/,
        /historyScopeOverride/,
        /event\.detail\?\.coworkerId/,
        /skills\.retest/,
        /Create Routine/,
        /create-routine-from-skill/,
        /item\.state === "active"/,
        /detail: \{ skillId: item\.id \}/,
        /teams\.duplicatePack/,
        /teams\.exportPackRecipe/,
        /teams\.importPackViaDialog/,
        /teams\.exportPackViaDialog/,
        /Preview \/ 预览/,
        /openProductChannelEditor/,
        /team-pack-page-import/,
        /openPackEditor/,
        /team-pack-editor-form/,
        /teams\.editPack/,
        /playbook-editor-name/,
        /playbook-editor-stages/,
        /playbooks\.exportViaDialog/,
        /playbooks\.importViaDialog/,
        /open-playbook-editor/,
        /skills\.exportViaDialog/,
        /skills\.importViaDialog/,
        /open-skill-editor/,
        /skill-editor-input-name/,
        /skill-editor-capability/,
        /requestedCapabilities/,
    ]) assert.match(productHubs, expression);
    assert.doesNotMatch(productHubs, /window\.prompt\("Channel/);
    assert.doesNotMatch(productHubs, /Edit declarative Team Pack JSON/);
    assert.doesNotMatch(productHubs, /Paste Playbook JSON/);
    assert.doesNotMatch(productHubs, /Semantic plan JSON/);
    assert.doesNotMatch(productHubs, /window\.prompt\("Playbook/);
    assert.doesNotMatch(productHubs, /window\.prompt\("Skill/);
    assert.doesNotMatch(productHubs, /Paste safe Skill JSON/);
    assert.doesNotMatch(productHubs, /innerHTML\s*=/);
    assert.doesNotMatch(productHubs, /eval\s*\(/);
});

test("Team Pack gallery includes differentiated first-party categories and safe composition preview", () => {
    for (const category of ["Product", "Sales", "Support"]) assert.match(html, new RegExp(`value="${category}"`), category);
    assert.match(html, /Product, Sales, and Support/);
    assert.match(productHubs, /team-pack-preview/);
    assert.match(productHubs, /Composition \/ 组成/);
    assert.match(productHubs, /team-pack-file-result/);
    assert.doesNotMatch(productHubs, /Paste Team Pack JSON/);
    assert.doesNotMatch(productHubs, /innerHTML\s*=/);
});

test("This PC is a status-first Coworker surface with safe detail entry points", () => {
    for (const id of ["nav-this-pc", "view-this-pc", "this-pc-project", "this-pc-refresh", "this-pc-list"]) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /See what each Coworker is doing/);
    for (const expression of [
        /computer\.health\?\.status/,
        /Show latest screen \/ 查看最新画面/,
        /Show page details \/ 查看页面详情/,
        /sovereignbot:open-artifacts/,
        /sovereignbot:open-computer-history/,
        /No latest screen yet/,
        /No page details loaded/,
        /context\?\.label/,
        /open-artifacts.*coworkerId/,
    ]) assert.match(thisPcUi, expression);
    for (const expression of [/sovereignbot:open-artifacts/, /sovereignbot:open-computer-history/]) assert.match(productHubs, expression);
    assert.doesNotMatch(thisPcUi, /Computer Node|WebDriver|driver|lease|profile path|absolute path|provider account|authority|session|token/i);
    assert.doesNotMatch(html.match(/<section id="view-this-pc"[\s\S]*?<\/section>/)?.[0] ?? "", /Computer Node|WebDriver|driver|lease|profile path|absolute path|provider account|authority|session|token/i);
    assert.match(css, /\.this-pc-grid/);
    assert.match(css, /\.this-pc-status/);
});
