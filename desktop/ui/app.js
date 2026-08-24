"use strict";

// Renderer entry point. The renderer is fully sandboxed: no Node, no fs, no child_process.
// The only privileged surface is window.sovereignbot exposed by the preload through
// contextBridge, and every call goes to an enumerated IPC channel.

async function main() {
    const chipVersion = document.getElementById("chip-version");
    const note = document.getElementById("foundation-note");

    let handshake;
    try {
        handshake = await window.sovereignbot.handshake();
    }
    catch {
        chipVersion.textContent = "desktop unavailable";
        chipVersion.className = "chip chip-error";
        return;
    }

    if (!handshake?.ok) {
        chipVersion.textContent = "runtime error";
        chipVersion.className = "chip chip-error";
        note.textContent = handshake?.error ? `Runtime failed to start: ${handshake.error}` : "Runtime failed to start.";
        note.classList.remove("hidden");
        return;
    }

    chipVersion.textContent = `${handshake.version} · ${handshake.platform}`;
    chipVersion.className = "chip chip-ok";
}

main();
