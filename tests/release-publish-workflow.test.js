import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKFLOW_PATH = ".github/workflows/publish-release.yml";

function section(text, start, end) {
    const from = text.indexOf(start);
    assert.notEqual(from, -1, `missing section: ${start}`);
    const to = end ? text.indexOf(end, from + start.length) : text.length;
    return text.slice(from, to === -1 ? text.length : to);
}

test("public release workflow is gated by successful main CI and narrows write authority to publish job", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /workflows:\s*\["CI"\]/);
    assert.match(workflow, /types:\s*\[completed\]/);
    assert.match(workflow, /branches:\s*\[main\]/);
    assert.doesNotMatch(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);

    assert.match(workflow, /permissions:\s*\n\s*contents: read/);
    const verify = section(workflow, "  verify:", "\n  publish:");
    const publish = section(workflow, "  publish:");
    assert.match(verify, /github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(verify, /github\.event\.workflow_run\.event == 'push'/);
    assert.match(verify, /github\.event\.workflow_run\.head_branch == 'main'/);
    assert.match(verify, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    assert.match(verify, /git fetch --no-tags origin main/);
    assert.match(verify, /Release candidate is no longer current main HEAD/);
    assert.doesNotMatch(verify, /contents: write/);

    assert.match(publish, /needs: verify/);
    assert.match(publish, /needs\.verify\.outputs\.publish == 'true'/);
    assert.match(publish, /permissions:\s*\n\s*contents: write/);
    assert.match(publish, /actions\/download-artifact@v4/);
});

test("public release workflow requires stable version, reviewed notes, verified artifact handoff and immutable tag", async () => {
    const workflow = await readFile(WORKFLOW_PATH, "utf8");
    assert.match(workflow, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
    assert.match(workflow, /notes="docs\/releases\/v\$version\.md"/);
    assert.match(workflow, /Package version \$version is not a stable release version; publication is intentionally skipped/);
    assert.match(workflow, /npm run check/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run test:browser/);
    assert.match(workflow, /npm run build:release/);
    assert.match(workflow, /sha256sum -c/);
    assert.match(workflow, /actions\/upload-artifact@v4/);
    assert.match(workflow, /actions\/download-artifact@v4/);

    assert.match(workflow, /git ls-remote --exit-code --tags origin/);
    assert.match(workflow, /Existing tag \$RELEASE_TAG points to a different commit; refusing to move it/);
    assert.doesNotMatch(workflow, /git tag\s+-f/);
    assert.doesNotMatch(workflow, /git push\s+--force/);
    assert.match(workflow, /gh release view "\$RELEASE_TAG"/);
    assert.match(workflow, /refusing to overwrite it/);
    assert.match(workflow, /gh release create "\$RELEASE_TAG" dist\/\*/);
    assert.match(workflow, /--verify-tag/);
    assert.match(workflow, /--notes-file "\$RELEASE_NOTES"/);
});

test("v1 release documentation is reviewed and changelog ships in the declared product payload", async () => {
    const [pkgRaw, changelog, migration, notes, buildScript] = await Promise.all([
        readFile("package.json", "utf8"),
        readFile("CHANGELOG.md", "utf8"),
        readFile("docs/v1-migration.md", "utf8"),
        readFile("docs/releases/v1.0.0.md", "utf8"),
        readFile("scripts/build-release.mjs", "utf8"),
    ]);
    const pkg = JSON.parse(pkgRaw);
    assert.ok(pkg.files.includes("CHANGELOG.md"));
    assert.match(buildScript, /"CHANGELOG\.md"/);
    assert.match(changelog, /## \[1\.0\.0\] - Unreleased/);
    assert.match(changelog, /docs\/v1-migration\.md/);
    assert.match(migration, /ComputerRegistry v0\.3 → v2/);
    assert.match(migration, /docs\/state-backup\.md|state-backup\.md/);
    assert.match(notes, /# SovereignBot 1\.0\.0/);
    assert.match(notes, /security review/);
    assert.match(notes, /RC soak/);

    if (/^\d+\.\d+\.\d+$/.test(pkg.version)) {
        const stableNotes = await readFile(`docs/releases/v${pkg.version}.md`, "utf8");
        assert.ok(stableNotes.trim().length > 0, "stable package version must have reviewed release notes");
    }
});
