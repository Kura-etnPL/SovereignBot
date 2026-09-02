import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { validateV3IpcRequest } from "./lib/v3-ipc-schema.js";

export const PLAYBOOK_FILE_MAX_BYTES = 64 * 1024;

function safeFileStem(value) {
    const stem = String(value ?? "playbook")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return stem || "playbook";
}

function jsonText(value) {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > PLAYBOOK_FILE_MAX_BYTES)
        throw new Error("Playbook export exceeds " + PLAYBOOK_FILE_MAX_BYTES + " bytes");
    return text;
}

export async function importPlaybookViaDialog({ parentWindow, dialog, importPlaybook, readFileFn = readFile } = {}) {
    const selected = await dialog.showOpenDialog(parentWindow, {
        title: "Import Playbook",
        properties: ["openFile", "dontAddToRecent"],
        filters: [{ name: "Playbook JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePaths?.length) return { canceled: true };
    let contents;
    try { contents = await readFileFn(selected.filePaths[0]); } catch { throw new Error("Could not read the selected Playbook file"); }
    const buffer = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    if (!Buffer.isBuffer(buffer) || buffer.byteLength > PLAYBOOK_FILE_MAX_BYTES)
        throw new Error("Playbook file exceeds " + PLAYBOOK_FILE_MAX_BYTES + " bytes");
    let playbook;
    try { playbook = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error("Playbook file is not valid JSON"); }
    const validated = validateV3IpcRequest("playbook:import", { playbook });
    const result = await importPlaybook(validated.playbook);
    return { canceled: false, fileName: basename(selected.filePaths[0]), ...result };
}

export async function exportPlaybookViaDialog({ parentWindow, dialog, resolvePlaybook, targetName, writeFileFn = writeFile } = {}) {
    const playbook = await resolvePlaybook();
    const text = jsonText(playbook);
    const selected = await dialog.showSaveDialog(parentWindow, {
        title: "Export Playbook",
        defaultPath: safeFileStem(playbook?.name ?? targetName) + ".json",
        filters: [{ name: "Playbook JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    try { await writeFileFn(selected.filePath, text, { encoding: "utf8", flag: "w" }); } catch { throw new Error("Could not save the Playbook file"); }
    return { canceled: false, fileName: basename(selected.filePath), bytes: Buffer.byteLength(text, "utf8") };
}
