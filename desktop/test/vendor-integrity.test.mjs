import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { verifyVendorTree } from "../src/main/lib/vendor-integrity.js";

const FILES = {
    "src/a.js": "export const A = 1;\n",
    "src/b.js": "export const B = 2;\n",
};

function sha256(text) {
    return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function makeDeps({ declaredExtra = {}, actualExtra = {}, tamper = {} } = {}) {
    const declaredFiles = { ...FILES, ...declaredExtra };
    const actualFiles = { ...FILES, ...actualExtra };
    const manifestFiles = {};
    for (const [rel, body] of Object.entries(declaredFiles))
        manifestFiles[rel] = tamper[rel] ?? sha256(body);
    return {
        rootDir: "/vendor/core",
        manifest: { schema: "x", fileCount: Object.keys(manifestFiles).length, files: manifestFiles },
        listFiles: () => Object.keys(actualFiles),
        readFileBuffer: (rel) => Buffer.from(actualFiles[rel] ?? "", "utf8"),
        sha256Buffer: (buffer) => createHash("sha256").update(buffer).digest("hex"),
    };
}

test("intact vendor tree verifies", () => {
    assert.deepEqual(verifyVendorTree(makeDeps()), { files: 2, ok: true });
});

test("missing declared file fails closed", () => {
    assert.throws(
        () => verifyVendorTree(makeDeps({ declaredExtra: { "src/gone.js": "x" } })),
        /missing declared file/,
    );
});

test("undeclared extra file fails closed", () => {
    assert.throws(
        () => verifyVendorTree(makeDeps({ actualExtra: { "src/sneaky.js": "evil" } })),
        /undeclared file/,
    );
});

test("tampered content fails closed", () => {
    assert.throws(
        () => verifyVendorTree(makeDeps({ tamper: { "src/b.js": sha256("different") } })),
        /failed integrity check/,
    );
});
