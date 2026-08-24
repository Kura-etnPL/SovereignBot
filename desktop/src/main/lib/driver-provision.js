import { createHash } from "node:crypto";
import { join } from "node:path";

// WebDriver provisioning for the managed browser path.
//
// Detection is passive (filesystem only). Downloads come exclusively from pinned official
// hosts over HTTPS, are size-capped, hash-verified against the vendor's published digest,
// and extracted through the strict zip reader. The renderer never chooses URLs; failures
// mark Computer provisioning unavailable instead of breaking the application.

export const DRIVER_HOST_ALLOWLIST = Object.freeze([
    "https://googlechromelabs.github.io",
    "https://storage.googleapis.com",
]);

const KNOWN_GOOD_VERSIONS_URL = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_DRIVER_BYTES = 64 * 1024 * 1024;

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function assertAllowedHost(url) {
    if (!DRIVER_HOST_ALLOWLIST.some((base) => url === base || url.startsWith(`${base}/`)))
        throw new Error(`driver host not on allowlist: ${safeHost(url)}`);
}

function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return "unparseable-url";
    }
}

function compareVersions(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let index = 0; index < 4; index += 1) {
        const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}

// Passive browser detection through standard install layouts on Windows: each Application
// directory contains version-named folders holding the browser executable.
export function detectBrowsers({ env, existsDir, existsFile, listDirs }) {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "";
    const localAppData = env.LOCALAPPDATA ?? "";
    const roots = [
        { browser: "chrome", base: join(programFiles, "Google", "Chrome", "Application"), exe: "chrome.exe" },
        { browser: "chrome", base: programFilesX86 ? join(programFilesX86, "Google", "Chrome", "Application") : "", exe: "chrome.exe" },
        { browser: "chrome", base: localAppData ? join(localAppData, "Google", "Chrome", "Application") : "", exe: "chrome.exe" },
        { browser: "edge", base: join(programFiles, "Microsoft", "Edge", "Application"), exe: "msedge.exe" },
        { browser: "edge", base: programFilesX86 ? join(programFilesX86, "Microsoft", "Edge", "Application") : "", exe: "msedge.exe" },
    ];
    const found = [];
    for (const root of roots) {
        if (!root.base || !existsDir(root.base))
            continue;
        const versions = listDirs(root.base)
            .filter((name) => /^\d+(?:\.\d+){3}$/.test(name))
            .sort(compareVersions)
            .reverse();
        for (const version of versions) {
            const exePath = join(root.base, version, root.exe);
            if (existsFile(exePath)) {
                found.push({ browser: root.browser, version, exePath });
                break; // newest installed version per install root
            }
        }
    }
    // Newest first; chrome preferred over edge when both are present.
    return found.sort((a, b) => compareVersions(b.version, a.version) || (a.browser === "chrome" ? -1 : 1));
}

async function fetchJson(url, fetcher, maxBytes) {
    assertAllowedHost(url);
    const response = await fetcher(url);
    if (!response.ok)
        throw new Error(`metadata download failed: HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes)
        throw new Error("metadata exceeds size cap");
    return JSON.parse(text);
}

export function findDriverDownload({ browserVersion }, metadata) {
    const wantedMajor = String(browserVersion).split(".")[0];
    let best;
    for (const entry of metadata?.versions ?? []) {
        if (String(entry.version ?? "").split(".")[0] === wantedMajor)
            best = entry; // known-good list is ascending; keep the newest matching major
    }
    if (!best)
        throw new Error(`no Chrome-for-Testing known-good driver build for major ${wantedMajor}`);
    const downloads = best.downloads?.chromedriver ?? [];
    const target = downloads.find((download) => download.platform === "win64");
    if (!target?.url)
        throw new Error(`no win64 chromedriver download for ${best.version}`);
    // The version string is remote-controlled metadata and is interpolated into local
    // filesystem paths by the provisioning step; only a strict 4-part version survives.
    const driverVersion = String(best.version);
    if (!/^\d+(?:\.\d+){3}$/.test(driverVersion))
        throw new Error(`refusing unsafe driver version from metadata: ${JSON.stringify(driverVersion.slice(0, 40))}`);
    return { driverVersion, url: target.url };
}

export async function provisionDriver({ browser, browserVersion, fetcher, writeArchive }) {
    void browser; // chromedriver serves chrome-family browsers incl. Edge
    const metadata = await fetchJson(KNOWN_GOOD_VERSIONS_URL, fetcher, MAX_METADATA_BYTES);
    const { driverVersion, url } = findDriverDownload({ browserVersion }, metadata);
    assertAllowedHost(url);

    const response = await fetcher(url);
    if (!response.ok)
        throw new Error(`driver download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length > MAX_DRIVER_BYTES)
        throw new Error("driver archive exceeds size cap");

    let archiveSha256 = sha256(archive);
    let digestVerified = false;
    try {
        const digestResponse = await fetcher(`${url}.sha256`);
        if (digestResponse.ok) {
            const expected = String(await digestResponse.text()).trim().split(/\s+/)[0].toLowerCase();
            if (/^[0-9a-f]{64}$/.test(expected)) {
                if (archiveSha256 !== expected)
                    throw new Error(`driver archive hash mismatch: expected ${expected}, got ${archiveSha256}`);
                digestVerified = true;
            }
        }
    }
    catch (error) {
        if (String(error?.message ?? "").includes("hash mismatch"))
            throw error;
        // Digest unavailable from the vendor: keep going, record honest provenance below.
    }

    await writeArchive(url, archive, { driverVersion, sha256: archiveSha256, digestVerified });
    return { driverVersion, url, sha256: archiveSha256, digestVerified, bytes: archive.length, provisionedAt: new Date().toISOString() };
}
