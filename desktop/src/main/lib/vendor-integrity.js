// Vendor Core payload integrity verification (pure, dependency-injected).
//
// desktop/vendor/core is a build-time copy of the repo-root Core sources. Its committed
// manifest lists every file with a SHA-256; RuntimeHost refuses to start unless every file
// still matches, so stale/tampered copies fail closed instead of silently running old code.
export function verifyVendorTree({ rootDir, manifest, listFiles, readFileBuffer, sha256Buffer }) {
    if (!manifest || typeof manifest !== "object" || !manifest.files || typeof manifest.files !== "object")
        throw new Error("vendor core manifest is missing or malformed");

    const declaredPaths = Object.keys(manifest.files).sort();
    const actualFiles = listFiles(rootDir).sort();
    const actualSet = new Set(actualFiles);

    for (const rel of declaredPaths) {
        if (!actualSet.has(rel)) {
            throw new Error(`vendor core is missing declared file: ${rel} (run "npm run sync-core")`);
        }
    }
    for (const rel of actualFiles) {
        if (!(rel in manifest.files)) {
            throw new Error(`vendor core contains undeclared file: ${rel} (run "npm run sync-core")`);
        }
    }
    for (const rel of declaredPaths) {
        const digest = sha256Buffer(readFileBuffer(rel));
        if (digest !== manifest.files[rel]) {
            throw new Error(`vendor core file failed integrity check: ${rel} (stale or tampered copy)`);
        }
    }
    return { files: declaredPaths.length, ok: true };
}

export function expectedManifestShape(manifest) {
    return Boolean(
        manifest &&
        typeof manifest === "object" &&
        Number.isInteger(manifest.fileCount) &&
        manifest.files &&
        typeof manifest.files === "object",
    );
}
