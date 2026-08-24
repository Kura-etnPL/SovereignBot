// Sandboxed preload. Runs with nodeIntegration disabled and sandbox enabled, so it may only
// use the electron CJS shim (contextBridge/ipcRenderer) — never fs, child_process, or Node
// globals. The exposed surface stays enumerated; there is no generic invoke(channel, payload)
// escape hatch, and no channel accepts caller-chosen authority fields.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("sovereignbot", Object.freeze({
    handshake: invoke("app:handshake"),
    firstRun: Object.freeze({
        getStatus: invoke("firstrun:getStatus"),
    }),
    workspaces: Object.freeze({
        addViaDialog: invoke("workspace:addViaDialog"),
        list: invoke("workspace:list"),
        setDefault: invoke("workspace:setDefault"),
        remove: invoke("workspace:remove"),
    }),
    settings: Object.freeze({
        get: invoke("settings:get"),
        update: invoke("settings:update"),
    }),
    goals: Object.freeze({
        submit: invoke("goal:submit"),
        list: invoke("goal:list"),
        getStatus: invoke("goal:getStatus"),
        getConversation: invoke("goal:getConversation"),
        cancel: invoke("goal:cancel"),
    }),
    operator: Object.freeze({
        getOverview: invoke("operator:getOverview"),
        getWorkers: invoke("operator:getWorkers"),
        getAudit: invoke("operator:getAudit"),
        searchMemory: invoke("operator:searchMemory"),
        getPolicy: invoke("operator:getPolicy"),
        getPolicyVersion: invoke("operator:getPolicyVersion"),
        validatePolicy: invoke("operator:validatePolicy"),
        dryRunPolicy: invoke("operator:dryRunPolicy"),
        applyPolicy: invoke("operator:applyPolicy"),
        rollbackPolicy: invoke("operator:rollbackPolicy"),
        getTaskGraph: invoke("operator:getTaskGraph"),
        getTaskEvents: invoke("operator:getTaskEvents"),
    }),
    computer: Object.freeze({
        control: invoke("computer:control"),
        lifecycle: invoke("computer:lifecycle"),
        supplySecret: invoke("computer:supplySecret"),
        browserStatus: invoke("computer:browserStatus"),
        provisionDriver: invoke("computer:provisionDriver"),
    }),
}));
