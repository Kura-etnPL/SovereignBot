#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const exe = join(root, "resources", "node", "node.exe");
const manifestPath = join(root, "resources", "node-runtime.manifest.json");
const args = process.argv.slice(2);
if (!existsSync(exe)) { console.error(`[run-forge] missing ${exe} — run npm run fetch-node`); process.exit(1); }
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.sha256) {
    const hash = createHash("sha256").update(readFileSync(exe)).digest("hex");
    if (hash !== manifest.sha256) { console.error(`[run-forge] sha mismatch ${hash} != ${manifest.sha256}`); process.exit(1); }
  }
} catch {}
const forge = join(root, "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js");
const result = spawnSync(exe, [forge, ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
