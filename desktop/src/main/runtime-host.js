import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyVendorTree } from "./lib/vendor-integrity.js";
import { prepareInternalNode } from "./internal-node.js";

const DESKTOP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENDOR_ROOT = join(DESKTOP_ROOT, "vendor", "core");
const VENDOR_MANIFEST_PATH = join(VENDOR_ROOT, "core-manifest.json");

// The vendored Core payload is the reviewed Core source tree copied at build time by
// scripts/sync-core.mjs and recorded file-by-file with SHA-256s in vendor/core/core-manifest.json.
// Startup re-verifies every file and refuses to run a stale or tampered copy.
function readVendorManifest() {
    return JSON.parse(readFileSync(VENDOR_MANIFEST_PATH, "utf8"));
}

function listVendorFiles() {
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === "core-manifest.json")
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else if (entry.isFile())
                out.push(relative(VENDOR_ROOT, full).replaceAll("\\", "/"));
        }
    };
    walk(VENDOR_ROOT);
    return out;
}

export function verifyVendorCore() {
    return verifyVendorTree({
        rootDir: VENDOR_ROOT,
        manifest: readVendorManifest(),
        listFiles: listVendorFiles,
        readFileBuffer: (rel) => readFileSync(join(VENDOR_ROOT, rel)),
        sha256Buffer: (buffer) => createHash("sha256").update(buffer).digest("hex"),
    });
}

let cachedCore = undefined;

async function loadCore() {
    cachedCore ??= await import(pathToFileURL(join(VENDOR_ROOT, "src", "runtime.js")).href);
    return cachedCore;
}

// Desktop RuntimeHost, foundation scope:
//  - verifies the vendored Core tree fail-closed;
//  - pins the internal Node interpreter for Core child processes;
//  - constructs the durable Core runtime in-process (no loopback HTTP server) with an
//    offline-safe agent set until first-run provider discovery lands.
export async function startRuntimeHost({ dataDir }) {
    verifyVendorCore();
    const internalNode = prepareInternalNode();

    const { createRuntime } = await loadCore();
    const runtime = await createRuntime({
        dataDir,
        bindHost: "127.0.0.1",
        port: 0,
        agents: [{
            id: "local-echo",
            name: "Local Echo",
            role: "worker",
            capabilities: ["demo"],
            harness: { kind: "echo" },
        }],
        policy: {
            repeatWindowMs: 180000,
            rules: [
                {
                    id: "deny-runaway-loop",
                    effect: "deny",
                    match: { category: "harness", operation: "run", repeatAtLeast: 10 },
                },
                {
                    id: "allow-local-echo",
                    effect: "allow",
                    match: { category: "harness", operation: "run", targetGlob: "echo" },
                },
            ],
        },
    });

    return {
        runtime,
        internalNodeSource: internalNode.source,
        async close() {
            await runtime.close();
        },
    };
}
