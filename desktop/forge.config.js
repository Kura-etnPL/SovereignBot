import { join } from "node:path";

const rootDirname = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
    packagerConfig: {
        name: "SovereignBot",
        executableName: "SovereignBot",
        asar: true,
        // Bundled internal Node ships outside the ASAR so it stays an independently
        // hash-verifiable resource; the manifest inside the ASAR pins its expected SHA-256.
        extraResource: [join(rootDirname, "resources", "node")],
        ignore: [
            /^\/out($|\/)/,
            /^\/test($|\/)/,
            /^\/scripts($|\/)/,
            /^\/resources\/node($|\/)/,
        ],
        // Supply-chain pin: pass the official Electron distribution checksum directly so the
        // packager never needs to fetch SHASUMS256.txt at build time. When bumping the
        // electron devDependency, update this hash from the official SHASUMS256.txt in the
        // same reviewed change.
        download: {
            checksums: {
                "electron-v43.4.1-win32-x64.zip": "c2ef9a5f65472c34d14bd3e67b7d14e66b0c01f124aba45263d6a4232160e13a",
            },
        },
    },
    rebuildConfig: {},
    makers: [],
};
