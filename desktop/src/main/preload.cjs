// Sandboxed preload. Runs with nodeIntegration disabled and sandbox enabled, so it may only
// use the electron CJS shim (contextBridge/ipcRenderer) — never fs, child_process, or Node
// globals. The exposed surface stays enumerated; there is no generic invoke(channel, payload)
// escape hatch.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sovereignbot", Object.freeze({
    handshake: () => ipcRenderer.invoke("app:handshake"),
}));
