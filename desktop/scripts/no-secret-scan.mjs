// Blocking secret scan over the packaged Desktop payload (and the source tree as a fallback).
// Rejects canary/credential-shaped markers in file bytes and suspicious filenames in the
// packaged output. This is a tripwire, not a proof; runtime redaction is covered by tests.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const DESKTOP_ROOT = process.cwd();
const OUT_DIR = join(DESKTOP_ROOT, "out");

const MARKERS = [
    "provider_session_CANARY",
    "worker_bearer_CANARY",
    "operator_bearer_CANARY",
    "bridge_capability_CANARY",
    "browser_cookie_CANARY",
    "secret_plaintext_CANARY",
    "BEGIN RSA PRIVATE KEY",
    "BEGIN EC PRIVATE KEY",
    "BEGIN OPENSSH PRIVATE KEY",
    "sk-proj-",
];

const FILENAME_PATTERNS = [
    /^\.env($|\.)|(^|[\\/])secrets?\.(json|txt)$/i,
    /password/i,
    /credential/i,
    /\.pem$/i,
    /\.pfx$/i,
    /\.key$/i,
];

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory())
            yield* walk(full);
        else if (entry.isFile())
            yield full;
    }
}

function main() {
    const target = existsSync(OUT_DIR) ? OUT_DIR : join(DESKTOP_ROOT, "vendor");
    if (!existsSync(target))
        throw new Error(`nothing to scan: ${OUT_DIR} and vendor are both missing`);
    console.error(`[secret-scan] scanning ${target}`);

    const findings = [];
    for (const path of walk(target)) {
        const name = path.slice(target.length + 1);
        for (const pattern of FILENAME_PATTERNS) {
            if (pattern.test(name))
                findings.push({ path: name, reason: `suspicious filename (${pattern})` });
        }
        let bytes;
        try {
            bytes = readFileSync(path);
        }
        catch {
            continue;
        }
        const text = bytes.toString("latin1");
        for (const marker of MARKERS) {
            if (text.includes(marker))
                findings.push({ path: name, reason: `contains marker "${marker}"` });
        }
    }

    if (findings.length) {
        for (const finding of findings)
            console.error(`[secret-scan] FAIL ${finding.path}: ${finding.reason}`);
        throw new Error(`secret scan found ${findings.length} finding(s)`);
    }
    console.log(JSON.stringify({ secretScan: "clean", scanned: target }));
}

main();
