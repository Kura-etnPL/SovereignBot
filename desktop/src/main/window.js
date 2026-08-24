import { BrowserWindow } from "electron";
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
