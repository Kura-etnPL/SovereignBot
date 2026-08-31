// Sandboxed preload. Runs with nodeIntegration disabled and sandbox enabled, so it may only
// use the electron CJS shim (contextBridge/ipcRenderer) — never fs, child_process, or Node
// globals. The exposed surface stays enumerated; there is no generic invoke(channel,payload)
// escape hatch.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("sovereignbot", Object.freeze({
    handshake: invoke("app:handshake"),
    firstRun: Object.freeze({ getStatus: invoke("firstrun:getStatus") }),
    workspaces: Object.freeze({ addViaDialog: invoke("workspace:addViaDialog"), list: invoke("workspace:list"), setDefault: invoke("workspace:setDefault"), remove: invoke("workspace:remove") }),
    settings: Object.freeze({ get: invoke("settings:get"), update: invoke("settings:update") }),
    coworkers: Object.freeze({ list: invoke("coworker:list"), get: invoke("coworker:get"), create: invoke("coworker:create"), update: invoke("coworker:update"), archive: invoke("coworker:archive"), restore: invoke("coworker:restore") }),
    teams: Object.freeze({ list: invoke("team:list"), get: invoke("team:get"), installPack: invoke("team:installPack"), exportPack: invoke("team:exportPack"), exportPackRecipe: invoke("team:exportPackRecipe"), importPack: invoke("team:importPack"), duplicatePack: invoke("team:duplicatePack"), editPack: invoke("team:editPack"), exportPlaybook: invoke("team:exportPlaybook"), importPlaybook: invoke("team:importPlaybook"), createChannelFromTemplate: invoke("team:createChannelFromTemplate") }),
    channels: Object.freeze({ list: invoke("channel:list"), get: invoke("channel:get"), create: invoke("channel:create"), update: invoke("channel:update"), archive: invoke("channel:archive"), restore: invoke("channel:restore") }),
    connectedApps: Object.freeze({ list: invoke("connectedApps:list"), assign: invoke("connectedApps:assign") }),
    skills: Object.freeze({ list: invoke("skill:list"), get: invoke("skill:get"), create: invoke("skill:create"), update: invoke("skill:update"), archive: invoke("skill:archive"), restore: invoke("skill:restore"), assign: invoke("skill:assign"), export: invoke("skill:export"), import: invoke("skill:import"), duplicate: invoke("skill:duplicate") }),
    playbooks: Object.freeze({ list: invoke("playbook:list"), create: invoke("playbook:create"), update: invoke("playbook:update"), archive: invoke("playbook:archive"), restore: invoke("playbook:restore"), duplicate: invoke("playbook:duplicate"), export: invoke("playbook:export"), import: invoke("playbook:import"), assign: invoke("playbook:assign") }),
    teachOnce: Object.freeze({ list: invoke("teach:list"), start: invoke("teach:start"), get: invoke("teach:get"), snapshot: invoke("teach:snapshot"), recordAction: invoke("teach:recordAction"), finish: invoke("teach:finish"), test: invoke("teach:test"), save: invoke("teach:save"), cancel: invoke("teach:cancel") }),
    conversations: Object.freeze({ list: invoke("conversation:list"), get: invoke("conversation:get"), createDirect: invoke("conversation:createDirect"), createTeam: invoke("conversation:createTeam"), send: invoke("conversation:send"), stop: invoke("conversation:stop"), redirect: invoke("conversation:redirect") }),
    artifacts: Object.freeze({ list: invoke("artifact:list"), hub: invoke("artifact:hub"), get: invoke("artifact:get"), preview: invoke("artifact:preview"), reveal: invoke("artifact:reveal"), attachViaDialog: invoke("artifact:attachViaDialog") }),
    goals: Object.freeze({ submit: invoke("goal:submit"), list: invoke("goal:list"), getStatus: invoke("goal:getStatus"), getConversation: invoke("goal:getConversation"), cancel: invoke("goal:cancel") }),
    jobs: Object.freeze({ submit: invoke("job:submit"), list: invoke("job:list"), getStatus: invoke("job:getStatus"), getConversation: invoke("job:getConversation"), cancel: invoke("job:cancel"), pause: invoke("job:pause"), resume: invoke("job:resume"), approve: invoke("job:approve"), dismiss: invoke("job:dismiss"), attention: invoke("job:attention") }),
    routines: Object.freeze({ create: invoke("routine:create"), list: invoke("routine:list"), get: invoke("routine:get"), history: invoke("routine:history"), setEnabled: invoke("routine:setEnabled"), remove: invoke("routine:remove") }),
    eventTriggers: Object.freeze({ create: invoke("eventTrigger:create"), list: invoke("eventTrigger:list"), get: invoke("eventTrigger:get"), setEnabled: invoke("eventTrigger:setEnabled"), remove: invoke("eventTrigger:remove") }),
    workerNodes: Object.freeze({ pairViaDialog: invoke("workerNode:pairViaDialog"), list: invoke("workerNode:list"), get: invoke("workerNode:get"), refresh: invoke("workerNode:refresh"), setEnabled: invoke("workerNode:setEnabled"), remove: invoke("workerNode:remove") }),
    operator: Object.freeze({ getOverview: invoke("operator:getOverview"), getWorkers: invoke("operator:getWorkers"), getAudit: invoke("operator:getAudit"), searchMemory: invoke("operator:searchMemory"), getPolicy: invoke("operator:getPolicy"), getPolicyVersion: invoke("operator:getPolicyVersion"), validatePolicy: invoke("operator:validatePolicy"), dryRunPolicy: invoke("operator:dryRunPolicy"), applyPolicy: invoke("operator:applyPolicy"), rollbackPolicy: invoke("operator:rollbackPolicy"), getTaskGraph: invoke("operator:getTaskGraph"), getTaskEvents: invoke("operator:getTaskEvents") }),
    computer: Object.freeze({ control: invoke("computer:control"), lifecycle: invoke("computer:lifecycle"), frame: invoke("computer:frame"), history: invoke("computer:history"), supplySecret: invoke("computer:supplySecret"), browserStatus: invoke("computer:browserStatus"), provisionDriver: invoke("computer:provisionDriver") }),
    providers: Object.freeze({ getRoster: invoke("provider:getRoster"), refresh: invoke("provider:refresh"), openLogin: invoke("provider:openLogin"), setRoleAssignment: invoke("provider:setRoleAssignment") }),
    onNavigate: (handler) => {
        const wrapped = (_event, target) => handler(target);
        ipcRenderer.on("sovereignbot:navigate", wrapped);
        return () => ipcRenderer.removeListener("sovereignbot:navigate", wrapped);
    },
    onNewChat: (handler) => {
        const wrapped = () => handler();
        ipcRenderer.on("sovereignbot:newChat", wrapped);
        return () => ipcRenderer.removeListener("sovereignbot:newChat", wrapped);
    },
    onToggleComputer: (handler) => {
        const wrapped = () => handler();
        ipcRenderer.on("sovereignbot:toggleComputer", wrapped);
        return () => ipcRenderer.removeListener("sovereignbot:toggleComputer", wrapped);
    },
    onToggleActivity: (handler) => {
        const wrapped = () => handler();
        ipcRenderer.on("sovereignbot:toggleActivity", wrapped);
        return () => ipcRenderer.removeListener("sovereignbot:toggleActivity", wrapped);
    },
}));
