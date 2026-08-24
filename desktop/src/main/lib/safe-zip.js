import { inflateRawSync } from "node:zlib";

// Minimal, strict ZIP reader for driver provisioning. Dependency-free by design so the
// supply chain stays auditable. Refuses anything beyond plain files in a bounded tree:
// absolute paths, traversal segments, NUL bytes, unusual compression methods, symlink/
// special attribute entries, duplicate names, and per-entry/total size caps.

const MAX_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function findEocd(buffer) {
    const signature = 0x06054b50;
    for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 66_000); index -= 1) {
        if (buffer.readUInt32LE(index) === signature)
            return index;
    }
    throw new Error("zip end-of-central-directory not found");
}

export function listZipEntries(buffer) {
    const eocd = findEocd(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (count > MAX_ENTRIES)
        throw new Error(`zip has too many entries (${count})`);
    const entries = [];
    const seen = new Set();
    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50)
            throw new Error("bad central directory entry");
        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const crcExpected = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const externalAttributes = buffer.readUInt32LE(offset + 38);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;

        assertSafeEntryName(name);
        if (seen.has(name))
            throw new Error(`duplicate zip entry: ${name}`);
        seen.add(name);
        // Unix mode bits live in the high 16 bits; symlink type bits are refused outright.
        const unixMode = (externalAttributes >>> 16) & 0xffff;
        if ((unixMode & 0o170000) === 0o120000)
            throw new Error(`refusing symlink entry in archive: ${name}`);
        if (flags & 0x0001)
            throw new Error(`encrypted zip entries are not supported: ${name}`);
        if (method !== 0 && method !== 8)
            throw new Error(`unsupported compression method ${method} for ${name}`);
        if (compressedSize > MAX_ENTRY_BYTES)
            throw new Error(`zip entry too large: ${name}`);

        entries.push({ name, method, crcExpected, compressedSize, uncompressedSize, localOffset });
    }
    return entries;
}

export function extractZip(buffer, { writeFile }) {
    const entries = listZipEntries(buffer);
    let total = 0;
    for (const entry of entries) {
        if (entry.name.endsWith("/"))
            continue;
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL_BYTES)
            throw new Error("archive exceeds total extraction budget");
        const localHeader = entry.localOffset;
        if (buffer.readUInt32LE(localHeader) !== 0x04034b50)
            throw new Error(`bad local header for ${entry.name}`);
        const nameLength = buffer.readUInt16LE(localHeader + 26);
        const extraLength = buffer.readUInt16LE(localHeader + 28);
        const dataStart = localHeader + 30 + nameLength + extraLength;
        const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
        let content;
        if (entry.method === 0)
            content = Buffer.from(raw);
        else
            content = inflateRawSync(raw);
        if (content.length !== entry.uncompressedSize)
            throw new Error(`size mismatch extracting ${entry.name}`);
        if (entry.crcExpected !== crc32(content))
            throw new Error(`crc mismatch extracting ${entry.name}`);
        writeFile(entry.name, content);
    }
    return { entries: entries.length, bytes: total };
}

export function assertSafeEntryName(name) {
    if (!name || name.includes("\0"))
        throw new Error("invalid zip entry name");
    if (/^[A-Za-z]:/.test(name) || name.startsWith("/") || name.startsWith("\\") || /^\\\\/.test(name))
        throw new Error(`absolute path in archive: ${name}`);
    const segments = name.split(/[\\/]/);
    if (segments.some((segment) => segment === ".."))
        throw new Error(`traversal in archive: ${name}`);
}

// Standard CRC-32 (IEEE), table computed once.
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buffer) {
    let crc = -1;
    for (let index = 0; index < buffer.length; index += 1)
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
    return (crc ^ -1) >>> 0;
}
