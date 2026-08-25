import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// lib -> main -> src -> desktop (three levels up). A previous two-level path silently
// resolved into src/package.json, which only worked when nothing read the value.
const DESKTOP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function desktopVersion() {
    return JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8")).version;
}

export const VERSION = desktopVersion();
