import { basename } from "node:path";
import { writeFile } from "node:fs/promises";

export const PROJECT_FILE_MAX_BYTES = 64 * 1024;

function safeFileStem(value) {
    const stem = String(value ?? "project")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return stem || "project";
}

function jsonText(value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > PROJECT_FILE_MAX_BYTES)
        throw new Error(`Project export exceeds ${PROJECT_FILE_MAX_BYTES} bytes`);
    return text;
}

export async function exportProjectViaDialog({ parentWindow, dialog, resolveProject, targetName, writeFileFn = writeFile } = {}) {
    const project = await resolveProject();
    const text = jsonText(project);
    const selected = await dialog.showSaveDialog(parentWindow, {
        title: "Export Project",
        defaultPath: `${safeFileStem(project?.project?.name ?? targetName)}.json`,
        filters: [{ name: "Project JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    try { await writeFileFn(selected.filePath, text, { encoding: "utf8", flag: "w" }); } catch { throw new Error("Could not save the Project file"); }
    return { canceled: false, fileName: basename(selected.filePath), bytes: Buffer.byteLength(text, "utf8") };
}
