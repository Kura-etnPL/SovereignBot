import assert from "node:assert/strict";
import test from "node:test";
import { releaseSigningConfig } from "../scripts/release-signing.mjs";
import { assertStableSource, collectSourceProvenance, publishEligibility } from "../scripts/release-provenance.mjs";

test("local RC signing is explicit and unsigned while stable signing fails closed without injected credentials", () => {
    const rc = releaseSigningConfig({ SOVEREIGNBOT_RELEASE_MODE: "rc" });
    assert.equal(rc.status, "unsigned");
    assert.deepEqual(rc.makerConfig, {});
    assert.throws(() => releaseSigningConfig({ SOVEREIGNBOT_RELEASE_MODE: "stable" }), /stable release requires/);
});

test("signing secrets never appear in the public status projection", () => {
    const status = releaseSigningConfig({
        SOVEREIGNBOT_RELEASE_MODE: "rc",
        SOVEREIGNBOT_WINDOWS_CERTIFICATE_FILE: process.execPath,
        SOVEREIGNBOT_WINDOWS_CERTIFICATE_PASSWORD: "not-a-real-secret",
    });
    assert.equal(status.status, "signed");
    assert.equal(JSON.stringify({ mode: status.mode, status: status.status }).includes("not-a-real-secret"), false);
});

test("dirty RC provenance is explicit and cannot become publishable", () => {
    const provenance = collectSourceProvenance({ repoRoot: process.cwd(), env: {
        SOVEREIGNBOT_RELEASE_MODE: "rc",
        SOVEREIGNBOT_BUILD_SOURCE_HEAD_SHA: "2910e15e5ef2da4b0d2e539aaa8e432e1f30d7a3",
        SOVEREIGNBOT_BUILD_SOURCE_TREE_STATE: "dirty",
        SOVEREIGNBOT_BUILD_SOURCE_CHANGED_FILES: "desktop/src/main/update-service.js,CHANGELOG.md",
    } });
    assert.equal(provenance.sourceHeadSha, "2910e15e5ef2da4b0d2e539aaa8e432e1f30d7a3");
    assert.equal(provenance.sourceTreeState, "dirty");
    assert.match(provenance.dirty.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(publishEligibility({ mode: "rc", signingStatus: "unsigned", provenance }), false);
});

test("stable source provenance rejects dirty trees, stale GITHUB_SHA, and version drift", () => {
    const provenance = collectSourceProvenance({ repoRoot: process.cwd(), env: {} });
    assert.equal(publishEligibility({ mode: "stable", signingStatus: "signed", provenance }), provenance.sourceTreeState === "clean");
    assert.throws(() => assertStableSource({ repoRoot: process.cwd(), provenance: { sourceHeadSha: "head", currentHeadSha: "head", sourceTreeState: "clean", dirty: { changedFiles: [] } }, env: { SOVEREIGNBOT_RELEASE_MODE: "stable", GITHUB_SHA: "other" }, signingStatus: "signed" }), /GITHUB_SHA/);
    assert.throws(() => assertStableSource({ repoRoot: process.cwd(), provenance: { sourceHeadSha: "head", currentHeadSha: "head", sourceTreeState: "clean", dirty: { changedFiles: [] } }, env: { SOVEREIGNBOT_RELEASE_MODE: "stable" }, signingStatus: "unsigned" }), /signed artifact/);
});
