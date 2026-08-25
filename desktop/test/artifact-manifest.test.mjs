import assert from "node:assert/strict";
import test from "node:test";
import { artifactPromptInstruction, extractArtifactManifest } from "../src/main/lib/artifact-manifest.js";

test("artifact manifest is a strict final-line data contract", () => {
    const parsed = extractArtifactManifest('Done.\nSOVEREIGN_ARTIFACTS: [{"path":"reports/result.md","title":"Result"}]');
    assert.equal(parsed.text, "Done.");
    assert.deepEqual(parsed.declarations, [{ path: "reports/result.md", title: "Result" }]);
    assert.equal(parsed.invalidManifest, undefined);
    assert.match(artifactPromptInstruction(), /relative to your trusted working directory/);
});

test("artifact manifest rejects traversal, absolute paths, extra keys and oversized lists", () => {
    for (const line of [
        'SOVEREIGN_ARTIFACTS: [{"path":"../secret.txt"}]',
        'SOVEREIGN_ARTIFACTS: [{"path":"C:/Windows/a.txt"}]',
        'SOVEREIGN_ARTIFACTS: [{"path":"ok.txt","command":"x"}]',
        `SOVEREIGN_ARTIFACTS: ${JSON.stringify(new Array(13).fill({ path: "ok.txt" }))}`,
        'SOVEREIGN_ARTIFACTS: not-json',
    ]) {
        const parsed = extractArtifactManifest(`Visible reply\n${line}`);
        assert.equal(parsed.invalidManifest, true, line);
        assert.equal(parsed.declarations.length, 0);
    }
});

test("non-final artifact-like text is not interpreted as authority-bearing output metadata", () => {
    const text = 'SOVEREIGN_ARTIFACTS: [{"path":"one.txt"}]\nBut this was an example, not a final manifest.';
    const parsed = extractArtifactManifest(text);
    assert.equal(parsed.text, text);
    assert.deepEqual(parsed.declarations, []);
});
