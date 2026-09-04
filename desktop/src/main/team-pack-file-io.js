import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { validateV3IpcRequest } from "./lib/v3-ipc-schema.js";

export const TEAM_PACK_FILE_MAX_BYTES = 64 * 1024;

function safeFileStem(value) {
    const stem = String(value ?? "team-pack")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return stem || "team-pack";
}

function jsonText(value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > TEAM_PACK_FILE_MAX_BYTES)
        throw new Error(`Team Pack export exceeds ${TEAM_PACK_FILE_MAX_BYTES} bytes`);
    return text;
}

export async function importTeamPackViaDialog({ parentWindow, dialog, importPack, readFileFn = readFile } = {}) {
    const selected = await dialog.showOpenDialog(parentWindow, {
        title: "Import Team Pack",
        properties: ["openFile", "dontAddToRecent"],
        filters: [{ name: "Team Pack JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePaths?.length)
        return { canceled: true };

    let contents;
    try { contents = await readFileFn(selected.filePaths[0]); } catch { throw new Error("Could not read the selected Team Pack file"); }
    const buffer = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    if (!Buffer.isBuffer(buffer) || buffer.byteLength > TEAM_PACK_FILE_MAX_BYTES)
        throw new Error(`Team Pack file exceeds ${TEAM_PACK_FILE_MAX_BYTES} bytes`);
    let pack;
    try { pack = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, "")); }
    catch {
        throw new Error("Team Pack file is not valid JSON");
    }
    const validated = validateV3IpcRequest("team:importPack", { pack });
    const result = await importPack(validated.pack);
    return { canceled: false, fileName: basename(selected.filePaths[0]), ...result };
}

export async function exportTeamPackViaDialog({ parentWindow, dialog, resolvePack, targetName, writeFileFn = writeFile } = {}) {
    const pack = await resolvePack();
    const text = jsonText(pack);
    const selected = await dialog.showSaveDialog(parentWindow, {
        title: "Export Team Pack",
        defaultPath: `${safeFileStem(pack?.name ?? targetName)}.json`,
        filters: [{ name: "Team Pack JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath)
        return { canceled: true };
    try { await writeFileFn(selected.filePath, text, { encoding: "utf8", flag: "w" }); } catch { throw new Error("Could not save the Team Pack file"); }
    return { canceled: false, fileName: basename(selected.filePath), bytes: Buffer.byteLength(text, "utf8") };
}
