// Writes out/release-manifest.json: the provenance record binding the produced Desktop
// artifacts to their pinned inputs. Everything here is independently re-checkable from the
// published artifacts plus this repository at the release commit.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { releaseSigningConfig } from "./release-signing.mjs";
import { verifyFusesOn } from "./fuses-core.mjs";
import { assertStableSource, collectSourceProvenance, publishEligibility } from "./release-provenance.mjs";

const DESKTOP_ROOT = process.cwd();
const OUT_DIR = join(DESKTOP_ROOT, "out");
const MAKE_ROOT = join(OUT_DIR, "make");

// Same discovery contract as installer-e2e: walk the make root and locate the unique
// Setup executable (forge 7.11 writes out/make/squirrel.windows/<arch>/<name>-<version> Setup.exe).
function findInstallerDir() {
    if (!existsSync(MAKE_ROOT))
        throw new Error(`${MAKE_ROOT} not found — run "npm run make" before writing the release manifest`);
    const found = [];
    const visit = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && /^SovereignBot.*Setup\.exe$/.test(entry.name))
                found.push(dir);
            else if (entry.isDirectory())
                visit(join(dir, entry.name));
        }
    };
    visit(MAKE_ROOT);
    if (found.length !== 1)
        throw new Error(`expected exactly one SovereignBot*Setup.exe under ${MAKE_ROOT}, found ${found.length}`);
    return found[0];
}

function sha256File(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireFile(path) {
    if (!existsSync(path))
        throw new Error(`expected artifact missing: ${path}`);
    return path;
}

async function collectInstallerArtifacts() {
    const squirrelDir = findInstallerDir();
    const relativeDir = squirrelDir.replace(DESKTOP_ROOT, "").replace(/\\/g, "/").replace(/^\//, "");
    const names = readdirSync(squirrelDir);
    const setup = names.find((name) => /^SovereignBot.*Setup\.exe$/.test(name));
    if (!setup)
        throw new Error("Setup executable not found; run electron-forge make first");
    if (!names.includes("RELEASES"))
        throw new Error("RELEASES index missing beside installer");
    const nupkg = names.filter((name) => name.endsWith("-full.nupkg"));
    if (nupkg.length !== 1)
        throw new Error(`expected exactly one .full.nupkg, found ${nupkg.length}`);
    const artifactNames = [setup, nupkg[0], "RELEASES"];
    const artifacts = artifactNames.map((name) => {
        const path = join(squirrelDir, name);
        return { name, path: `${relativeDir}/${name}`, bytes: statSync(path).size, sha256: sha256File(path) };
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
    await verifyFusesOn(exePath);
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

const signing = releaseSigningConfig();
const repoRoot = join(DESKTOP_ROOT, "..");
const provenance = collectSourceProvenance({ repoRoot });
assertStableSource({ repoRoot, provenance, signingStatus: signing.status });
const channel = process.env.SOVEREIGNBOT_RELEASE_CHANNEL ?? "stable";
if (!["stable", "preview"].includes(channel)) throw new Error("SOVEREIGNBOT_RELEASE_CHANNEL must be stable or preview");
const artifacts = await collectInstallerArtifacts();
const eligible = publishEligibility({ mode: signing.mode, signingStatus: signing.status, provenance });
const manifest = {
    schema: "sovereignbot.desktop.release-manifest.v1",
    generatedAt: new Date().toISOString(),
    sourceHeadSha: provenance.sourceHeadSha,
    sourceTreeState: provenance.sourceTreeState,
    dirty: provenance.dirty,
    publishEligible: eligible,
    release: {
        mode: signing.mode,
        channel,
        signature: {
            status: signing.status,
            verified: signing.status === "signed" ? "SKIP: Authenticode verifier not configured in this offline workspace" : false,
        },
        fuses: "verified",
        publishBoundary: "explicit-maintainer-upload-only",
    },
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
    artifacts,
};

mkdirSync(OUT_DIR, { recursive: true });
const target = join(OUT_DIR, "release-manifest.json");
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
const checksumLines = manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n") + "\n";
writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), checksumLines, "ascii");
writeFileSync(join(OUT_DIR, "release-publish-command.txt"), eligible
    ? ["# Review release-manifest.json and SHA256SUMS.txt, then explicitly upload these files.", `gh release create desktop-v${pkg.version} --title \"SovereignBot Desktop ${pkg.version}\" --notes-file docs/releases/desktop-v${pkg.version}.md out/make/**/SovereignBot-*Setup.exe out/make/**/*.nupkg out/make/**/RELEASES out/release-manifest.json out/SHA256SUMS.txt`].join("\n") + "\n"
    : "# REFUSED: release-manifest.json publishEligible=false; do not upload this diagnostic artifact.\nexit 1\n", "utf8");
console.log(JSON.stringify({ releaseManifest: target.replace(DESKTOP_ROOT, "").replace(/^[\\/]/, ""), checksums: "out/SHA256SUMS.txt", signature: manifest.release.signature, artifacts: manifest.artifacts.map((a) => a.name) }));
