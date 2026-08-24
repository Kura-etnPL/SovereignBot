import assert from "node:assert/strict";
import test from "node:test";
import { detectBrowsers, findDriverDownload, provisionDriver } from "../src/main/lib/driver-provision.js";

const METADATA_URL = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";

function fakeFilesystem(tree) {
    return {
        existsDir: (path) => tree[path]?.type === "dir",
        existsFile: (path) => tree[path]?.type === "file",
        listDirs: (path) => Object.keys(tree[path]?.children ?? {}),
    };
}

test("detectBrowsers picks the newest complete install per root, chrome before edge", () => {
    const pf = "C:\\Program Files";
    const chromeApp = `${pf}\\Google\\Chrome\\Application`;
    const edgeApp = `${pf}\\Microsoft\\Edge\\Application`;
    const tree = {
        [chromeApp]: { type: "dir", children: { "138.0.0.1": {}, "139.0.5.0": {} } },
        [`${chromeApp}\\138.0.0.1`]: { type: "dir" },
        // 139 is present as a folder but the executable is missing: not a usable install.
        [`${chromeApp}\\139.0.5.0`]: { type: "dir", children: {} },
        [`${chromeApp}\\138.0.0.1\\chrome.exe`]: { type: "file" },
        [edgeApp]: { type: "dir", children: { "140.0.9.9": {} } },
        [`${edgeApp}\\140.0.9.9\\msedge.exe`]: { type: "file" },
    };
    const found = detectBrowsers({
        env: { ProgramFiles: pf, "ProgramFiles(x86)": "", LOCALAPPDATA: "" },
        ...fakeFilesystem(tree),
    });
    assert.deepEqual(found.map(({ browser, version }) => ({ browser, version })), [
        { browser: "edge", version: "140.0.9.9" },
        { browser: "chrome", version: "138.0.0.1" },
    ]);
});

test("findDriverDownload matches the newest known-good build of the browser's major", () => {
    const metadata = {
        versions: [
            { version: "139.0.7258.6", downloads: { chromedriver: [{ platform: "win64", url: "https://storage.googleapis.com/chrome-for-testing-public/139.0.7258.6/win64/chromedriver-win64.zip" }] } },
            { version: "140.0.7339.2", downloads: { chromedriver: [{ platform: "linux64", url: "https://storage.googleapis.com/x/linux64/chromedriver-linux64.zip" }] } },
            { version: "140.0.7339.80", downloads: { chromedriver: [
                { platform: "mac-arm64", url: "https://storage.googleapis.com/x/mac.zip" },
                { platform: "win64", url: "https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.80/win64/chromedriver-win64.zip" },
            ] } },
            { version: "141.0.8000.1", downloads: { chromedriver: [{ platform: "win64", url: "https://storage.googleapis.com/x/win.zip" }] } },
        ],
    };
    const match = findDriverDownload({ browserVersion: "140.0.5000.1" }, metadata);
    assert.equal(match.driverVersion, "140.0.7339.80");
    assert.equal(match.url.endsWith("/win64/chromedriver-win64.zip"), true);

    assert.throws(() => findDriverDownload({ browserVersion: "99.0.1.1" }, metadata), /major 99/);
    assert.throws(
        () => findDriverDownload({ browserVersion: "140.0.1.1" }, { versions: metadata.versions.slice(1, 2) }),
        /no win64 chromedriver/,
    );

    // A metadata entry whose version string would escape local path construction is
    // refused even when its major prefix matches the browser.
    const hostile = {
        versions: [
            {
                version: "140.0.0.1\\..\\..\\startup",
                downloads: { chromedriver: [{ platform: "win64", url: "https://storage.googleapis.com/x/win.zip" }] },
            },
        ],
    };
    assert.throws(() => findDriverDownload({ browserVersion: "140.0.5000.1" }, hostile), /refusing unsafe driver version/);
});

function fetcherFor({ metadataBody = JSON.stringify({ versions: [] }), driverArchive, sha256Text, statusByUrl = {} }) {
    return async (url) => {
        if (statusByUrl[url])
            return { ok: false, status: statusByUrl[url], text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
        if (url === METADATA_URL)
            return { ok: true, status: 200, text: async () => metadataBody, arrayBuffer: async () => new ArrayBuffer(0) };
        if (url.endsWith(".sha256"))
            return { ok: Boolean(sha256Text), status: sha256Text ? 200 : 404, text: async () => sha256Text ?? "", arrayBuffer: async () => new ArrayBuffer(0) };
        if (url.endsWith(".zip"))
            return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => driverArchive.buffer.slice(driverArchive.byteOffset, driverArchive.byteOffset + driverArchive.length) };
        throw new Error(`unexpected fetch ${url}`);
    };
}

const GOOD_METADATA = JSON.stringify({
    versions: [
        { version: "140.0.7339.80", downloads: { chromedriver: [{ platform: "win64", url: "https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.80/win64/chromedriver-win64.zip" }] } },
    ],
});
const ARCHIVE = Buffer.from("PKfake-driver-archive");

test("provisionDriver verifies vendor digest and records honest provenance", async () => {
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(ARCHIVE).digest("hex");

    const verified = await provisionDriver({
        browser: "chrome",
        browserVersion: "140.0.7339.80",
        fetcher: fetcherFor({ metadataBody: GOOD_METADATA, driverArchive: ARCHIVE, sha256Text: `${digest}  chromedriver-win64.zip` }),
        writeArchive: async () => {},
    });
    assert.equal(verified.digestVerified, true);
    assert.equal(verified.sha256, digest);

    // Vendor digest missing (404) still provisions but stays marked unverified.
    const unverified = await provisionDriver({
        browser: "chrome",
        browserVersion: "140.0.7339.80",
        fetcher: fetcherFor({ metadataBody: GOOD_METADATA, driverArchive: ARCHIVE }),
        writeArchive: async () => {},
    });
    assert.equal(unverified.digestVerified, false);

    // Digest present but wrong must hard-fail.
    await assert.rejects(
        provisionDriver({
            browser: "chrome",
            browserVersion: "140.0.7339.80",
            fetcher: fetcherFor({ metadataBody: GOOD_METADATA, driverArchive: ARCHIVE, sha256Text: "0".repeat(64) }),
            writeArchive: async () => {},
        }),
        /hash mismatch/,
    );
});

test("provisionDriver refuses download URLs outside the pinned host allowlist", async () => {
    const evilMetadata = JSON.stringify({
        versions: [
            { version: "140.0.7339.80", downloads: { chromedriver: [{ platform: "win64", url: "https://evil.example/chromedriver-win64.zip" }] } },
        ],
    });
    let wrote = false;
    await assert.rejects(
        provisionDriver({
            browser: "chrome",
            browserVersion: "140.0.7339.80",
            fetcher: fetcherFor({ metadataBody: evilMetadata, driverArchive: ARCHIVE }),
            writeArchive: async () => {
                wrote = true;
            },
        }),
        /allowlist/,
    );
    assert.equal(wrote, false);
});
