import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createInternalNodeResolver } from "../src/main/lib/internal-node-resolve.js";

const MANIFEST = {
    version: "v22.23.2",
    platforms: {
        "win32-x64": { file: "node.exe", sha256: "aaaa" },
    },
};

// Platform-correct expected paths: the resolver joins with node:path, so fixtures must
// compare against joined forms rather than literal separators.
const PACKAGED_NODE = join("C:/app/resources", "node.exe");
const DEV_NODE = join("E:/dev/desktop/resources", "node", "node.exe");

function makeResolver(overrides = {}) {
    return createInternalNodeResolver({
        env: {},
        isPackaged: true,
        resourcesPath: "C:/app/resources",
        desktopRoot: "E:/dev/desktop",
        execPathBasename: "SovereignBot.exe",
        processExecPath: "C:/app/SovereignBot.exe",
        exists: (path) => path === PACKAGED_NODE || path === DEV_NODE,
        sha256File: () => "aaaa",
        readManifest: () => MANIFEST,
        ...overrides,
    });
}

test("env override wins and is existence-checked", () => {
    const resolve = makeResolver({
        env: { SOVEREIGNBOT_INTERNAL_NODE: "D:/pinned/node.exe" },
        exists: (path) => path === "D:/pinned/node.exe",
    });
    const resolved = resolve();
    assert.deepEqual(resolved, { path: "D:/pinned/node.exe", source: "env-override", sha256: "aaaa" });

    const missing = makeResolver({
        env: { SOVEREIGNBOT_INTERNAL_NODE: "D:/absent/node.exe" },
        exists: () => false,
    });
    assert.throws(() => missing(), /does not exist/);
});

test("packaged build uses bundled resource after hash verification", () => {
    const resolved = makeResolver()();
    assert.equal(resolved.source, "bundled-packaged");
    assert.equal(resolved.path, PACKAGED_NODE);
});

test("hash mismatch on the bundled binary fails closed", () => {
    const resolve = makeResolver({ sha256File: () => "bbbb" });
    assert.throws(() => resolve(), /failed integrity check/);
});

test("dev mode falls back to system node only when execPath is genuinely Node", () => {
    const dev = makeResolver({
        isPackaged: false,
        exists: () => false,
        execPathBasename: "node.exe",
        processExecPath: "C:/Program Files/nodejs/node.exe",
    });
    const resolved = dev();
    assert.equal(resolved.source, "system-node-dev");

    const electronDev = makeResolver({ isPackaged: false, exists: () => false });
    assert.throws(() => electronDev(), /internal Node runtime is missing/);
});

test("unknown platform fails closed", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "sunos", configurable: true });
    try {
        assert.throws(() => makeResolver()(), /no pinned internal Node runtime/);
    }
    finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
});
