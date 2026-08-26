import { ipcMain } from "electron";
import { IPC_CHANNELS, validateIpcRequest } from "./lib/ipc-schema.js";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "./lib/v3-ipc-schema.js";

const LIVE_FRAME_CHANNEL = "computer:frame";
const ALL_IPC_CHANNELS = Object.freeze({
    ...IPC_CHANNELS,
    ...V3_IPC_CHANNELS,
    [LIVE_FRAME_CHANNEL]: Object.freeze({ direction: "renderer->main", maxPayloadBytes: 1024 }),
});

function validateLiveFrame(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("computer frame payload must be an object");
    if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "agentId"))
        throw new Error("computer frame payload accepts only agentId");
    if (typeof payload.agentId !== "string" || !/^[A-Za-z0-9][\w:.-]{0,127}$/.test(payload.agentId))
        throw new Error("agentId must be an identifier");
    return { agentId: payload.agentId };
}

function validateRequest(channel, payload) {
    if (channel === LIVE_FRAME_CHANNEL)
        return validateLiveFrame(payload);
    return V3_IPC_CHANNELS[channel]
        ? validateV3IpcRequest(channel, payload)
        : validateIpcRequest(channel, payload);
}

export function bindIpcChannels({ win, handlers }) {
    const bound = [];
    for (const channel of Object.keys(ALL_IPC_CHANNELS)) {
        const businessHandler = handlers[channel];
        if (!businessHandler)
            continue;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, payload) => {
            if (win.isDestroyed() || event.sender !== win.webContents || event.sender.isDestroyed())
                throw new Error("ipc sender is not the main window");
            const request = validateRequest(channel, payload);
            return businessHandler(request);
        });
        bound.push(channel);
    }
    return function unbindAll() {
        for (const channel of bound)
            ipcMain.removeHandler(channel);
    };
}

export function channelNames() {
    return Object.keys(ALL_IPC_CHANNELS);
}
