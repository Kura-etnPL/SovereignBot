import { ipcMain } from "electron";
import { IPC_CHANNELS, validateIpcRequest } from "./lib/ipc-schema.js";

// Binds the enumerated IPC surface. Every handler:
//  - accepts calls only from the main window's exact webContents (navigation-created or
//    forged frames are rejected before any business logic runs);
//  - validates the payload against the channel schema with size caps;
//  - never receives caller-chosen actor identities (handlers use fixed desktop principals).
export function bindIpcChannels({ win, handlers }) {
    const bound = [];
    for (const [channel, entry] of Object.entries(IPC_CHANNELS)) {
        const businessHandler = handlers[channel];
        if (!businessHandler)
            continue;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, payload) => {
            if (win.isDestroyed() || event.sender !== win.webContents || event.sender.isDestroyed())
                throw new Error("ipc sender is not the main window");
            const request = validateIpcRequest(channel, payload);
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
    return Object.keys(IPC_CHANNELS);
}
