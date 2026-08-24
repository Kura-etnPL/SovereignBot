import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function desktopVersion() {
    return JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8")).version;
}
