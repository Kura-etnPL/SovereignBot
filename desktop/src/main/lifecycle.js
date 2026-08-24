import { dialog } from "electron";

// Window close semantics driven by desktop settings (closeBehavior: ask | tray | quit).
// The interception is skipped while the app is actually quitting so Quit from the tray
// can never be trapped by its own close handler.

export function attachWindowLifecycle({ win, getCloseBehavior, rememberCloseBehavior, tray, isQuitting }) {
    win.on("close", async (event) => {
        if (isQuitting())
            return;
        const behavior = getCloseBehavior();

        if (behavior === "tray") {
            event.preventDefault();
            win.hide();
            tray?.notifyHidden();
            return;
        }

        if (behavior === "ask") {
            event.preventDefault();
            const { response, checkboxChecked } = await dialog.showMessageBox(win, {
                type: "question",
                title: "SovereignBot",
                message: "Keep SovereignBot running in the background?",
                detail: "Goals keep executing while the window is hidden. You can also quit from the tray icon.",
                buttons: ["Minimize to tray", "Quit"],
                defaultId: 0,
                cancelId: 0,
                checkboxLabel: "Remember my choice",
                checkboxChecked: false,
                noLink: true,
            });
            const choice = response === 1 ? "quit" : "tray";
            if (checkboxChecked)
                rememberCloseBehavior(choice);
            if (choice === "quit") {
                // Close for real this time; window-all-closed finalizes shutdown.
                win.destroy();
                return;
            }
            win.hide();
            tray?.notifyHidden();
        }
        // behavior === "quit": allow the close to proceed untouched.
    });

    win.on("show", () => tray?.onWindowVisibilityChanged?.());
    win.on("hide", () => tray?.onWindowVisibilityChanged?.());
}
