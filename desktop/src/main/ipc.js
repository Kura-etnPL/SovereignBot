import { ipcMain } from "electron";
import { IPC_CHANNELS, validateIpcRequest } from "./lib/ipc-schema.js";
import { V3_IPC_CHANNELS, validateV3IpcRequest } from "./lib/v3-ipc-schema.js";

const ALL_IPC_CHANNELS = Object.freeze({ ...IPC_CHANNELS, ...V3_IPC_CHANNELS });

function validateRequest(channel, payload) {
    return V3_IPC_CHANNELS[channel]
        ? validateV3IpcRequest(channel, payload)
        : validateIpcRequest(channel, payload);
}

// Binds the enumerated IPC surface. Every handler:
//  - accepts calls only from the main window's exact webContents;
//  - validates the payload against an exact channel schema with size caps;
//  - never receives caller-chosen authority or provider continuity fields.
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
