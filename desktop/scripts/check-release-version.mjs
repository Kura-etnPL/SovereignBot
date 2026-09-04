import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(process.cwd(), "..");
const desktop = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
const root = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const core = await readFile(join(ROOT, "src", "version.js"), "utf8");
const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
const version = desktop.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`release version must be stable SemVer, got ${version}`);
if (root.version !== version || !core.includes(`VERSION = "${version}"`) || lock.version !== version || lock.packages?.[""].version !== version)
    throw new Error(`version drift: root=${root.version} core=${core.match(/VERSION = "([^"]+)/)?.[1]} desktop=${version} lock=${lock.version}`);
console.log(JSON.stringify({ releaseVersion: version, sources: ["package.json", "src/version.js", "desktop/package.json", "desktop/package-lock.json"] }));
