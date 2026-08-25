import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "publish-desktop-release.yml");
const RETIRED_PATH = join(ROOT, ".github", "workflows", "desktop-release.yml");

function section(text, start, end) {
    const from = text.indexOf(start);
    assert.notEqual(from, -1, `missing section: ${start}`);
    const to = end ? text.indexOf(end, from + start.length) : text.length;
    return text.slice(from, to === -1 ? text.length : to);
}

test("desktop publication is gated by successful main Desktop CI with merged-PR provenance", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /workflows:\s*\["Desktop CI"\]/);
    assert.match(workflow, /types:\s*\[completed\]/);
    assert.match(workflow, /branches:\s*\[main\]/);
    // The retired attack path must stay dead: no tag push trigger, no manual dispatch.
    assert.doesNotMatch(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
});

test("verify job is read-only and enforces current-main plus merged-PR candidate locks", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    assert.match(workflow, /permissions:\s*\n\s*contents: read/);

    const verify = section(workflow, "\n  verify:", "\n  publish:");
    assert.match(verify, /github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(verify, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(verify, /github\.event\.workflow_run\.head_branch == 'main'/);
    assert.match(verify, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    assert.match(verify, /persist-credentials: false/);
    assert.match(verify, /pull-requests: read/);
    assert.match(verify, /git fetch --no-tags origin main/);
    assert.match(verify, /Release candidate is no longer current main HEAD/);
    assert.match(verify, /repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$sha\/pulls/);
    assert.match(verify, /\.merged_at != null/);
    assert.match(verify, /\.base\.ref == \\"main\\"/);
    assert.match(verify, /\.merge_commit_sha == \\"\$sha\\"/);
    assert.match(verify, /Stable release candidate is not the merge commit of a reviewed pull request into main/);
    assert.doesNotMatch(verify, /contents: write/);

    // Version consistency across root/Core/desktop before anything builds.
    assert.match(verify, /require\('\.\/desktop\/package\.json'\)\.version/);
    assert.match(verify, /require\('\.\/package\.json'\)\.version/);
    assert.match(verify, /require\('\.\/src\/version\.js'\)\.VERSION/);
    assert.match(verify, /does not match desktop version/);

    // Full gates run in verify (including the fake-provider installed E2E).
    for (const gate of ["npm run make", "npm run verify-fuses", "scripts/installer-e2e.mjs", "npm run secret-scan", "release-manifest"]) {
        assert.ok(verify.includes(gate), `verify job must run gate: ${gate}`);
    }
    for (const fake of ["FAKE_PROVIDER_NODE", "FAKE_PROVIDER_DIR"]) {
        assert.ok(verify.includes(fake), `verify E2E must declare ${fake}`);
    }
});

test("publish job holds write authority but never rebuilds or re-installs", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    const publish = section(workflow, "\n  publish:");
    assert.match(publish, /needs: verify/);
    assert.match(publish, /needs\.verify\.outputs\.publish == 'true'/);
    assert.match(publish, /permissions:\s*\n\s*contents: write/);
    assert.match(publish, /actions\/download-artifact@v4/);
    assert.match(publish, /sha256sum -c SHA256SUMS\.txt/);
    assert.match(publish, /Existing tag \$RELEASE_TAG points to a different commit; refusing to move it/);
    assert.match(publish, /already exists; refusing to overwrite it/);
    assert.match(publish, /git tag -a "\$RELEASE_TAG" "\$RELEASE_SHA"/);

    // Publish consumes verified artifacts only: no dependency install, no build, no tests.
    for (const forbidden of ["npm ci", "npm run make", "npm install", "electron-forge", "installer-e2e"]) {
        assert.ok(!publish.includes(forbidden), `publish job must not build (${forbidden})`);
    }
});

test("the retired tag-triggered single-job release workflow stays deleted", async () => {
    assert.equal(existsSync(RETIRED_PATH), false, "tag-triggered desktop-release.yml must not exist");
});
