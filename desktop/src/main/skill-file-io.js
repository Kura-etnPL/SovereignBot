import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

export const SKILL_FILE_MAX_BYTES = 64 * 1024;

function safeFileStem(value) {
    const stem = String(value ?? "skill")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return stem || "skill";
}

function jsonText(value) {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > SKILL_FILE_MAX_BYTES)
        throw new Error("Skill export exceeds " + SKILL_FILE_MAX_BYTES + " bytes");
    return text;
}

function validateSkillDocument(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill file must contain an object");
    const allowed = new Set(["schema", "name", "description", "instructions", "inputs", "steps", "expectedOutput", "requestedCapabilities", "validators", "source"]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("Skill file contains an unsupported authority field: " + key);
    if (value.schema !== "sovereignbot.desktop.skill.v1") throw new Error("Skill file schema is invalid");
    for (const [key, max, required] of [["name", 100, true], ["description", 280, false], ["instructions", 16_000, true], ["expectedOutput", 1_000, false]]) {
        if (typeof value[key] !== "string" || value[key].trim().length > max || (required && !value[key].trim())) throw new Error("Skill file " + key + " is invalid");
        if (/(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|https?:\/\/|(?:bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|secret|credential)\s*[:=]|(?:session[_ -]?id|provider[_ -]?(?:id|session|account)|webdriver|backendRef|rawPath|\bcwd\b))/i.test(value[key])) throw new Error("Skill file contains a private path, credential, runtime handle, or URL");
    }
    for (const [key, max, itemMax] of [["steps", 64, 800], ["validators", 24, 500]]) {
        if (!Array.isArray(value[key]) || value[key].length > max || value[key].some((entry) => typeof entry !== "string" || !entry.trim() || entry.trim().length > itemMax)) throw new Error("Skill file " + key + " is invalid");
    }
    if (!Array.isArray(value.inputs) || value.inputs.length > 16 || value.inputs.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !["name", "type", "description", "required"].includes(key)) || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.type !== "string" || typeof entry.description !== "string" || typeof entry.required !== "boolean")) throw new Error("Skill file inputs are invalid");
    if (!Array.isArray(value.requestedCapabilities) || value.requestedCapabilities.length > 2 || value.requestedCapabilities.some((entry) => !["computer", "workspace"].includes(entry))) throw new Error("Skill file requestedCapabilities are invalid");
    if (value.source !== undefined && !["manual", "taught", "imported"].includes(value.source)) throw new Error("Skill file source is invalid");
    return structuredClone(value);
}

export async function importSkillViaDialog({ parentWindow, dialog, importSkill, readFileFn = readFile } = {}) {
    const selected = await dialog.showOpenDialog(parentWindow, {
        title: "Import Skill",
        properties: ["openFile", "dontAddToRecent"],
        filters: [{ name: "Skill JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePaths?.length) return { canceled: true };
    let contents;
    try { contents = await readFileFn(selected.filePaths[0]); } catch { throw new Error("Could not read the selected Skill file"); }
    const buffer = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    if (!Buffer.isBuffer(buffer) || buffer.byteLength > SKILL_FILE_MAX_BYTES)
        throw new Error("Skill file exceeds " + SKILL_FILE_MAX_BYTES + " bytes");
    let skill;
    try { skill = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error("Skill file is not valid JSON"); }
    const result = await importSkill(validateSkillDocument(skill));
    return { canceled: false, fileName: basename(selected.filePaths[0]), ...result };
}

export async function exportSkillViaDialog({ parentWindow, dialog, resolveSkill, targetName, writeFileFn = writeFile } = {}) {
    const skill = await resolveSkill();
    const text = jsonText(skill);
    const selected = await dialog.showSaveDialog(parentWindow, {
        title: "Export Skill",
        defaultPath: safeFileStem(skill?.name ?? targetName) + ".json",
        filters: [{ name: "Skill JSON", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    try { await writeFileFn(selected.filePath, text, { encoding: "utf8", flag: "w" }); } catch { throw new Error("Could not save the Skill file"); }
    return { canceled: false, fileName: basename(selected.filePath), bytes: Buffer.byteLength(text, "utf8") };
}
