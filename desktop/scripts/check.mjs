import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function collect(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "vendor" || entry.name === "out" || entry.name === "node_modules")
                continue;
            out.push(...(await collect(path)));
        }
        else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
            out.push(path);
        }
    }
    return out;
}

const files = [
    ...(await collect("src")),
    ...(await collect("scripts")),
    ...(await collect("test")),
];
for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.status !== 0)
        process.exit(result.status ?? 1);
}
console.log(`syntax ok: ${files.length} files`);
