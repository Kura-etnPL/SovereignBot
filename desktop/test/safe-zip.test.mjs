import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { crc32, extractZip, listZipEntries } from "../src/main/lib/safe-zip.js";

// Builds a structurally valid zip by hand so the strict reader is tested against real
// byte layouts, including hostile ones no well-behaved archiver would produce.
function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const method = entry.method ?? 0;
        const flags = entry.flags ?? 0;
        const raw = method === 8 ? deflateRawSync(entry.data) : entry.data;
        const name = Buffer.from(entry.name, "utf8");
        const crc = entry.crcOverride ?? crc32(entry.data);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(flags, 6);
        localHeader.writeUInt16LE(method, 8);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(raw.length, 18);
        localHeader.writeUInt32LE(entry.data.length, 22);
        localHeader.writeUInt16LE(name.length, 26);
        localHeader.writeUInt16LE(0, 28);
        const localRecord = Buffer.concat([localHeader, name, raw]);
        locals.push(localRecord);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(entry.versionMadeBy ?? 0x031e, 4); // unix by default
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(raw.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(entry.externalAttributes ?? 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, name]));
        offset += localRecord.length;
    }
    const centralDirectory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralDirectory, eocd]);
}

test("round-trips plain and deflated entries", () => {
    const zip = buildZip([
        { name: "chromedriver.exe", data: Buffer.from("MZfake-executable") },
        { name: "nested/notes.txt", data: Buffer.from("hello deflated world".repeat(40)), method: 8 },
        { name: "folder/", data: Buffer.alloc(0) },
    ]);
    const written = [];
    const result = extractZip(zip, { writeFile: (name, content) => written.push([name, content]) });
    assert.equal(result.entries, 3);
    assert.equal(written.length, 2); // directory placeholder is skipped
    assert.deepEqual(written.map(([name]) => name), ["chromedriver.exe", "nested/notes.txt"]);
    assert.equal(written[1][1].toString(), "hello deflated world".repeat(40));
});

test("rejects traversal, absolute paths, NUL names, duplicates, symlinks, encryption, exotic methods", () => {
    const base = [{ name: "ok.txt", data: Buffer.from("fine") }];
    for (const [entry, pattern] of [
        [{ name: "../evil.txt", data: Buffer.alloc(0) }, /traversal/],
        [{ name: "..\\evil.txt", data: Buffer.alloc(0) }, /traversal/],
        [{ name: "/abs.txt", data: Buffer.alloc(0) }, /absolute path/],
        [{ name: "C:\\abs.txt", data: Buffer.alloc(0) }, /absolute path/],
        [{ name: "bad\0name.txt", data: Buffer.alloc(0) }, /invalid zip entry/],
        [{ name: "link", data: Buffer.alloc(0), externalAttributes: (0o120777 << 16) >>> 0 }, /symlink/],
        [{ name: "locked.txt", data: Buffer.from("x"), flags: 0x0001 }, /encrypted/],
        [{ name: "weird.bin", data: Buffer.from("x"), method: 12 }, /compression method 12/],
    ]) {
        assert.throws(() => listZipEntries(buildZip([...base, entry])), pattern, entry.name);
    }
    const duplicated = buildZip([...base, { name: "ok.txt", data: Buffer.from("again") }]);
    assert.throws(() => listZipEntries(duplicated), /duplicate zip entry/);
});

test("detects CRC corruption during extraction", () => {
    const zip = buildZip([{ name: "payload.bin", data: Buffer.from("trustworthy bytes"), crcOverride: 0xdeadbeef }]);
    assert.throws(() => extractZip(zip, { writeFile: () => {} }), /crc mismatch/);
});

test("rejects buffers without an end-of-central-directory record", () => {
    assert.throws(() => listZipEntries(Buffer.from("not a zip at all")), /end-of-central-directory/);
});
