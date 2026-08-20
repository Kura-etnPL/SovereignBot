import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(path)));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = [
  ...(await collect("src")),
  ...(await collect("sidecars")),
  ...(await collect("tests")),
  ...(await collect("scripts")),
  ...(await collect("examples")),
];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`syntax ok: ${files.length} files`);
