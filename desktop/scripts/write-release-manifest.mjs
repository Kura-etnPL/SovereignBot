// Writes out/release-manifest.json: the provenance record binding the produced Desktop
// artifacts to their pinned inputs. Everything here is independently re-checkable from the
// published artifacts plus this repository at the release commit.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const DESKTOP_ROOT = process.cwd();
const OUT_DIR = join(DESKTOP_ROOT, "out");
const SQUIRREL_DIR = join(OUT_DIR, "make", "squirrel-windows");

function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireFile(path) {
    if (!existsSync(path))
        throw new Error(`expected artifact missing: ${path}`);
    return path;
}

function collectInstallerArtifacts() {
    if (!existsSync(SQUIRREL_DIR))
        throw new Error(`${SQUIRREL_DIR} not found — run "npm run make" before writing the release manifest`);
    const names = readdirSync(SQUIRREL_DIR);
    const setup = names.find((name) => name === "SovereignBot-Setup.exe");
    if (!setup)
        throw new Error("SovereignBot-Setup.exe not found; run electron-forge make first");
    const nupkg = names.filter((name) => name.endsWith(".full.nupkg"));
    if (nupkg.length !== 1)
        throw new Error(`expected exactly one .full.nupkg, found ${nupkg.length}`);
    const artifactNames = ["SovereignBot-Setup.exe", nupkg[0], ...names.filter((name) => name === "RELEASES")];
    const artifacts = artifactNames.map((name) => {
        const path = join(SQUIRREL_DIR, name);
        return { name, path: `out/make/squirrel-windows/${name}`, bytes: statSync(path).size, sha256: sha256File(path) };
    });
    // The packaged application tree the installer was built from (fuses applied by the
    // postPackage hook before Squirrel hashed it).
    const appDir = readdirSync(OUT_DIR, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.endsWith("-win32-x64"));
    if (!appDir)
        throw new Error("packaged app directory missing under out/");
    const exePath = join(OUT_DIR, appDir.name, "SovereignBot.exe");
    requireFile(exePath);
    artifacts.push({
        name: `${appDir.name}/SovereignBot.exe`,
        path: `out/${appDir.name}/SovereignBot.exe`,
        bytes: statSync(exePath).size,
        sha256: sha256File(exePath),
    });
    return artifacts;
}

// The electron distribution pins live as literals in forge.config.js; extract them so the
// manifest records exactly what the reviewed build config enforces.
function extractElectronPins(text) {
    const pins = {};
    const pattern = /"(electron-v[^"]+)":\s*"([0-9a-f]{64})"/g;
    let match;
    while ((match = pattern.exec(text)) !== null)
        pins[match[1]] = match[2];
    if (!Object.keys(pins).length)
        throw new Error("no electron distribution sha256 pins found in forge.config.js");
    return pins;
}

const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8"));

// Core version truth lives in the vendored payload's src/version.js.
const vendorCoreManifestPath = join(DESKTOP_ROOT, "vendor", "core", "core-manifest.json");
const nodeRuntimeManifestPath = join(DESKTOP_ROOT, "resources", "node-runtime.manifest.json");

const manifest = {
    schema: "sovereignbot.desktop.release-manifest.v1",
    generatedAt: new Date().toISOString(),
    gitCommitSha: process.env.GITHUB_SHA ?? null,
    desktop: {
        version: pkg.version,
        electron: pkg.devDependencies.electron,
        forgeCli: pkg.devDependencies["@electron-forge/cli"],
        makerSquirrel: pkg.devDependencies["@electron-forge/maker-squirrel"] ?? null,
    },
    inputs: {
        electronDistributionZipSha256: extractElectronPins(readFileSync(join(DESKTOP_ROOT, "forge.config.js"), "utf8")),
        internalNodeRuntime: JSON.parse(readFileSync(nodeRuntimeManifestPath, "utf8")),
        vendoredCoreManifestSha256: sha256File(vendorCoreManifestPath),
    },
    acceptedBuildTimeRisk: {
        advisories: "devDependency-only audit findings (electron-forge chain incl. extract-zip/tar); no runtime dependency footprint",
        evidence: "npm audit --omit=dev reports 0 vulnerabilities",
    },
    artifacts: collectInstallerArtifacts(),
};

mkdirSync(OUT_DIR, { recursive: true });
const target = join(OUT_DIR, "release-manifest.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ releaseManifest: target.replace(DESKTOP_ROOT, "").replace(/^[\\/]/, ""), artifacts: manifest.artifacts.map((a) => a.name) }));
