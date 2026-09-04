import { Tray, Menu } from "electron";
import { fileURLToPath } from "node:url";

// System tray presence for Desktop v1.1. The tray exists so "close to tray" is a real
// choice: the runtime keeps working while the window is hidden. Quit in the tray menu
// is the only exit path from here.

const TRAY_ICON_PATH = fileURLToPath(new URL("./assets/tray.png", import.meta.url));

export function createTrayController({ getWindow, onQuit }) {
    let tray;

    try {
        tray = new Tray(TRAY_ICON_PATH);
    }
    catch {
        // Missing/unreadable icon must not take the app down; close semantics fall
        // back to plain quit behavior.
        return { notifyHidden() {}, destroy() {} };
    }

    tray.setToolTip("SovereignBot");
    const rebuild = () => {
        const win = getWindow();
        const hidden = !win || win.isDestroyed() || !win.isVisible();
        tray.setContextMenu(Menu.buildFromTemplate([
            {
                label: hidden ? "SovereignBot (hidden)" : "SovereignBot is running",
                enabled: false,
            },
            { type: "separator" },
            {
                label: "Show SovereignBot",
                click: () => {
                    const target = getWindow();
                    if (!target || target.isDestroyed())
                        return;
                    target.show();
                    target.focus();
                    rebuild();
                },
            },
            { type: "separator" },
            { label: "Quit SovereignBot", click: () => onQuit() },
        ]));
    };
    rebuild();

    return {
        onWindowVisibilityChanged: rebuild,
        notifyHidden() {
            // Closing to tray is a window-state transition, not a product event.
            // Product notifications are emitted only by notification-service.js.
        },
        destroy() {
            try {
                tray?.destroy();
            }
            catch {
            }
        },
    };
}
