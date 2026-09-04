import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(repoRoot, args) {
    const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout;
}

function changedFiles(status) {
    return status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter((value) => value && !value.includes("\0")).slice(0, 500);
}

export function collectSourceProvenance({ repoRoot, env = process.env } = {}) {
    const currentHeadSha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    const status = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const currentChangedFiles = changedFiles(status);
    const overrideHead = env.SOVEREIGNBOT_BUILD_SOURCE_HEAD_SHA;
    const overrideState = env.SOVEREIGNBOT_BUILD_SOURCE_TREE_STATE;
    const overrideFiles = env.SOVEREIGNBOT_BUILD_SOURCE_CHANGED_FILES;
    const sourceHeadSha = overrideHead ?? currentHeadSha;
    const sourceTreeState = overrideState ?? (currentChangedFiles.length ? "dirty" : "clean");
    if (!["clean", "dirty"].includes(sourceTreeState)) throw new Error("sourceTreeState must be clean or dirty");
    const changed = overrideFiles ? overrideFiles.split(/[,\r\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 500) : currentChangedFiles;
    if (sourceTreeState === "clean" && changed.length) throw new Error("clean source provenance cannot list changed files");
    if (sourceTreeState === "dirty" && !changed.length) throw new Error("dirty source provenance requires a changed-file summary");
    if (overrideHead || overrideState || overrideFiles) {
        if ((env.SOVEREIGNBOT_RELEASE_MODE ?? "rc") !== "rc") throw new Error("source provenance overrides are allowed only for local RC diagnostics");
    }
    const dirtyFingerprint = createHash("sha256").update(`${sourceHeadSha}\n${sourceTreeState}\n${changed.join("\n")}`).digest("hex");
    if (env.SOVEREIGNBOT_BUILD_SOURCE_DIRTY_FINGERPRINT && env.SOVEREIGNBOT_BUILD_SOURCE_DIRTY_FINGERPRINT !== dirtyFingerprint)
        throw new Error("source provenance dirty fingerprint mismatch");
    return { sourceHeadSha, currentHeadSha, sourceTreeState, dirty: { fingerprint: dirtyFingerprint, changedFiles: changed, truncated: changed.length >= 500 } };
}

export function assertStableSource({ repoRoot, provenance, env = process.env, signingStatus } = {}) {
    if (env.SOVEREIGNBOT_RELEASE_MODE !== "stable") return;
    if (signingStatus !== "signed") throw new Error("stable release requires a signed artifact");
    if (provenance.sourceTreeState !== "clean" || provenance.sourceHeadSha !== provenance.currentHeadSha)
        throw new Error("stable release requires a clean source tree at the artifact source HEAD");
    if (env.GITHUB_SHA && env.GITHUB_SHA !== provenance.currentHeadSha)
        throw new Error("stable release GITHUB_SHA must equal the checked-out HEAD");
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const desktopPkg = JSON.parse(readFileSync(join(repoRoot, "desktop", "package.json"), "utf8"));
    const core = readFileSync(join(repoRoot, "src", "version.js"), "utf8");
    if (!/^\d+\.\d+\.\d+$/.test(rootPkg.version) || rootPkg.version !== desktopPkg.version || !core.includes(`VERSION = "${rootPkg.version}"`))
        throw new Error("stable release requires consistent stable Core/Desktop versions");
}

export function publishEligibility({ mode, signingStatus, provenance } = {}) {
    return mode === "stable" && signingStatus === "signed" && provenance.sourceTreeState === "clean" && provenance.sourceHeadSha === provenance.currentHeadSha;
}
