import { BrowserWindow, Menu } from "electron";
import { fileURLToPath } from "node:url";
import { isAppUrl } from "./lib/app-assets.js";

const PRELOAD_PATH = fileURLToPath(new URL("./preload.cjs", import.meta.url));

export function createMainWindow({ smoke = false } = {}) {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 940,
        minHeight: 600,
        show: !smoke,
        backgroundColor: "#0e1116",
        autoHideMenuBar: true,
        title: "SovereignBot",
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            enableWebSQL: false,
            spellcheck: false,
            devTools: smoke,
        },
    });

    win.setMenuBarVisibility(false);
    try {
        const template = [
            {
                label: "SovereignBot",
                submenu: [
                    { role: "about" },
                    { type: "separator" },
                    {
                        label: "Settings",
                        accelerator: "CmdOrCtrl+,",
                        click: () => win.webContents.send("sovereignbot:navigate", "settings"),
                    },
                    {
                        label: "New conversation",
                        accelerator: "CmdOrCtrl+N",
                        click: () => win.webContents.send("sovereignbot:newChat"),
                    },
                    {
                        label: "Toggle Computer",
                        accelerator: "CmdOrCtrl+Shift+C",
                        click: () => win.webContents.send("sovereignbot:toggleComputer"),
                    },
                    {
                        label: "Activity",
                        accelerator: "CmdOrCtrl+Shift+A",
                        click: () => win.webContents.send("sovereignbot:toggleActivity"),
                    },
                    { type: "separator" },
                    { role: "quit" },
                ],
            },
            { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
        ];
        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    } catch {}

    // No popups, no arbitrary navigation, no <webview> attachment, and DevTools are closed
    // immediately in production builds (smoke mode may open them for debugging).
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
        if (!isAppUrl(url))
            event.preventDefault();
    });
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    if (!smoke) {
        win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
    }
    return win;
}

export function appOrigin() {
    return `sovereignbot://app/`;
}
