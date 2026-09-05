"use strict";

(() => {
  const invoke = (channel) => async (payload) => {
    try {
      const res = await fetch("/api/desktop/ipc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, payload: payload !== undefined ? payload : {} }),
      });
      const data = await res.json();
      if (!res.ok || (data && data.error)) {
        throw new Error((data && data.error) || "IPC call failed");
      }
      return data.result;
    } catch (err) {
      console.warn(`[SovereignBridge] ${channel} error:`, err);
      throw err;
    }
  };

  const listeners = new Map();

  function addWindowListener(eventName, handler) {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(handler);
    return () => listeners.get(eventName)?.delete(handler);
  }

  window.sovereignbot = Object.freeze({
    handshake: invoke("app:handshake"),
    firstRun: Object.freeze({ getStatus: invoke("firstrun:getStatus") }),
    workspaces: Object.freeze({ addViaDialog: invoke("workspace:addViaDialog"), list: invoke("workspace:list"), setDefault: invoke("workspace:setDefault"), remove: invoke("workspace:remove") }),
    projects: Object.freeze({ list: invoke("project:list"), get: invoke("project:get"), create: invoke("project:create"), open: invoke("project:open"), archive: invoke("project:archive"), restore: invoke("project:restore"), export: invoke("project:export"), exportViaDialog: invoke("project:exportViaDialog"), backup: invoke("project:backup") }),
    search: Object.freeze({ query: invoke("search:query") }),
    palette: Object.freeze({ list: invoke("palette:list"), execute: invoke("palette:execute") }),
    settings: Object.freeze({ get: invoke("settings:get"), update: invoke("settings:update") }),
    updates: Object.freeze({ status: invoke("update:status"), check: invoke("update:check"), stage: invoke("update:stage"), apply: invoke("update:apply"), setChannel: invoke("update:setChannel") }),
    dataLifecycle: Object.freeze({ status: invoke("data:status"), listBackups: invoke("data:listBackups"), backup: invoke("data:backup"), restore: invoke("data:restore"), export: invoke("data:export"), prepareReset: invoke("data:prepareReset"), reset: invoke("data:reset") }),
    coworkers: Object.freeze({ list: invoke("coworker:list"), get: invoke("coworker:get"), create: invoke("coworker:create"), update: invoke("coworker:update"), archive: invoke("coworker:archive"), restore: invoke("coworker:restore") }),
    memory: Object.freeze({ list: invoke("memory:list"), putFact: invoke("memory:putFact"), get: invoke("memory:get"), update: invoke("memory:update"), forget: invoke("memory:forget"), delete: invoke("memory:delete"), pin: invoke("memory:pin"), sourceTrace: invoke("memory:sourceTrace"), listSuggestions: invoke("memory:listSuggestions"), approveSuggestion: invoke("memory:approveSuggestion"), rejectSuggestion: invoke("memory:rejectSuggestion") }),
    teams: Object.freeze({ list: invoke("team:list"), get: invoke("team:get"), activity: invoke("team:activity"), requestCollaboration: invoke("team:requestCollaboration"), requestParallel: invoke("team:requestParallel"), computerTask: invoke("team:computerTask"), installPack: invoke("team:installPack"), exportPack: invoke("team:exportPack"), exportPackRecipe: invoke("team:exportPackRecipe"), importPack: invoke("team:importPack"), importPackViaDialog: invoke("team:importPackViaDialog"), exportPackViaDialog: invoke("team:exportPackViaDialog"), duplicatePack: invoke("team:duplicatePack"), editPack: invoke("team:editPack"), exportPlaybook: invoke("team:exportPlaybook"), importPlaybook: invoke("team:importPlaybook"), createChannelFromTemplate: invoke("team:createChannelFromTemplate") }),
    channels: Object.freeze({ list: invoke("channel:list"), get: invoke("channel:get"), create: invoke("channel:create"), update: invoke("channel:update"), archive: invoke("channel:archive"), restore: invoke("channel:restore") }),
    connectedApps: Object.freeze({ list: invoke("connectedApps:list"), search: invoke("connectedApps:search"), review: invoke("connectedApps:review"), assign: invoke("connectedApps:assign"), connect: invoke("connectedApps:connect"), disconnect: invoke("connectedApps:disconnect"), disable: invoke("connectedApps:disable"), health: invoke("connectedApps:health") }),
    skills: Object.freeze({ list: invoke("skill:list"), get: invoke("skill:get"), create: invoke("skill:create"), update: invoke("skill:update"), archive: invoke("skill:archive"), restore: invoke("skill:restore"), assign: invoke("skill:assign"), export: invoke("skill:export"), exportViaDialog: invoke("skill:exportViaDialog"), import: invoke("skill:import"), importViaDialog: invoke("skill:importViaDialog"), duplicate: invoke("skill:duplicate"), retest: invoke("skill:retest") }),
    playbooks: Object.freeze({ list: invoke("playbook:list"), create: invoke("playbook:create"), update: invoke("playbook:update"), archive: invoke("playbook:archive"), restore: invoke("playbook:restore"), duplicate: invoke("playbook:duplicate"), export: invoke("playbook:export"), exportViaDialog: invoke("playbook:exportViaDialog"), import: invoke("playbook:import"), importViaDialog: invoke("playbook:importViaDialog"), assign: invoke("playbook:assign") }),
    teachOnce: Object.freeze({ list: invoke("teach:list"), start: invoke("teach:start"), get: invoke("teach:get"), snapshot: invoke("teach:snapshot"), recordAction: invoke("teach:recordAction"), finish: invoke("teach:finish"), test: invoke("teach:test"), confirm: invoke("teach:confirm"), save: invoke("teach:save"), cancel: invoke("teach:cancel") }),
    conversations: Object.freeze({ list: invoke("conversation:list"), get: invoke("conversation:get"), acknowledge: invoke("conversation:acknowledge"), createDirect: invoke("conversation:createDirect"), createTeam: invoke("conversation:createTeam"), send: invoke("conversation:send"), stop: invoke("conversation:stop"), redirect: invoke("conversation:redirect") }),
    artifacts: Object.freeze({ list: invoke("artifact:list"), hub: invoke("artifact:hub"), get: invoke("artifact:get"), preview: invoke("artifact:preview"), open: invoke("artifact:open"), reveal: invoke("artifact:reveal"), history: invoke("artifact:history"), archive: invoke("artifact:archive"), restore: invoke("artifact:restore"), restoreAsNewVersion: invoke("artifact:restoreAsNewVersion"), reviseViaDialog: invoke("artifact:reviseViaDialog"), exportViaDialog: invoke("artifact:exportViaDialog"), attachViaDialog: invoke("artifact:attachViaDialog") }),
    goals: Object.freeze({ submit: invoke("goal:submit"), list: invoke("goal:list"), getStatus: invoke("goal:getStatus"), getConversation: invoke("goal:getConversation"), cancel: invoke("goal:cancel") }),
    jobs: Object.freeze({ submit: invoke("job:submit"), list: invoke("job:list"), getStatus: invoke("job:getStatus"), getConversation: invoke("job:getConversation"), cancel: invoke("job:cancel"), pause: invoke("job:pause"), resume: invoke("job:resume"), approve: invoke("job:approve"), snooze: invoke("job:snooze"), dismiss: invoke("job:dismiss"), attention: invoke("job:attention") }),
    notifications: Object.freeze({ list: invoke("notification:list"), markRead: invoke("notification:markRead"), markAllRead: invoke("notification:markAllRead"), clear: invoke("notification:clear"), clearAll: invoke("notification:clearAll") }),
    routines: Object.freeze({ create: invoke("routine:create"), list: invoke("routine:list"), get: invoke("routine:get"), history: invoke("routine:history"), runNow: invoke("routine:runNow"), archive: invoke("routine:archive"), restore: invoke("routine:restore"), retry: invoke("routine:retry"), setEnabled: invoke("routine:setEnabled"), remove: invoke("routine:remove") }),
    eventTriggers: Object.freeze({ create: invoke("eventTrigger:create"), list: invoke("eventTrigger:list"), get: invoke("eventTrigger:get"), setEnabled: invoke("eventTrigger:setEnabled"), remove: invoke("eventTrigger:remove") }),
    workerNodes: Object.freeze({ pairViaDialog: invoke("workerNode:pairViaDialog"), list: invoke("workerNode:list"), get: invoke("workerNode:get"), refresh: invoke("workerNode:refresh"), setEnabled: invoke("workerNode:setEnabled"), remove: invoke("workerNode:remove"), trustBegin: invoke("workerNode:trustBegin"), trustComplete: invoke("workerNode:trustComplete"), trustCompleteViaDialog: invoke("workerNode:trustCompleteViaDialog"), trustRevoke: invoke("workerNode:trustRevoke"), trustRotate: invoke("workerNode:trustRotate") }),
    computerTargets: Object.freeze({ list: invoke("computerTarget:list") }),
    externalControllers: Object.freeze({ list: invoke("externalController:list"), get: invoke("externalController:get"), pairingBegin: invoke("externalController:pairingBegin"), pairingComplete: invoke("externalController:pairingComplete"), revoke: invoke("externalController:revoke"), rotate: invoke("externalController:rotate") }),
    operator: Object.freeze({ getOverview: invoke("operator:getOverview"), getWorkers: invoke("operator:getWorkers"), getAudit: invoke("operator:getAudit"), searchMemory: invoke("operator:searchMemory"), getPolicy: invoke("operator:getPolicy"), getPolicyVersion: invoke("operator:getPolicyVersion"), validatePolicy: invoke("operator:validatePolicy"), dryRunPolicy: invoke("operator:dryRunPolicy"), applyPolicy: invoke("operator:applyPolicy"), rollbackPolicy: invoke("operator:rollbackPolicy"), getTaskGraph: invoke("operator:getTaskGraph"), getTaskEvents: invoke("operator:getTaskEvents") }),
    computer: Object.freeze({ control: invoke("computer:control"), lifecycle: invoke("computer:lifecycle"), frame: invoke("computer:frame"), history: invoke("computer:history"), supplySecret: invoke("computer:supplySecret"), browserStatus: invoke("computer:browserStatus"), provisionDriver: invoke("computer:provisionDriver") }),
    thisPc: Object.freeze({ list: invoke("thisPc:list"), frame: invoke("thisPc:frame"), snapshot: invoke("thisPc:snapshot"), takeOver: invoke("thisPc:takeOver"), handBack: invoke("thisPc:handBack"), health: invoke("thisPc:health") }),
    providers: Object.freeze({ getRoster: invoke("provider:getRoster"), refresh: invoke("provider:refresh"), openLogin: invoke("provider:openLogin"), setRoleAssignment: invoke("provider:setRoleAssignment"), setCoworkerAccount: invoke("provider:setCoworkerAccount") }),
    drive: Object.freeze({ config: invoke("drive:config"), list: invoke("drive:list"), upload: invoke("drive:upload"), delete: invoke("drive:delete") }),
    onNavigate: (handler) => addWindowListener("navigate", handler),
    onNewChat: (handler) => addWindowListener("newChat", handler),
    onToggleComputer: (handler) => addWindowListener("toggleComputer", handler),
    onToggleActivity: (handler) => addWindowListener("toggleActivity", handler),
  });

  console.log("[SovereignBot] Full Web IPC bridge loaded successfully.");
})();
