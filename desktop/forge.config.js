import { existsSync } from "node:fs";
import { join } from "node:path";
import { flipFusesOn, verifyFusesOn } from "./scripts/fuses-core.mjs";

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
    hooks: {
        // Fuses must be flipped on the packaged tree BEFORE Squirrel packs it into the
        // .nupkg (Squirrel records package hashes and refuses later edits). The hook is
        // the single fuse authority for every packaging path; the CLI script verifies.
        postPackage: async (_config, { outputPaths }) => {
            for (const outputPath of outputPaths) {
                const exeName = "SovereignBot";
                const exe = join(outputPath, `${exeName}.exe`);
                if (!existsSync(exe))
                    throw new Error(`postPackage: packaged executable not found at ${exe}`);
                await flipFusesOn(exe);
                await verifyFusesOn(exe);
            }
        },
    },
    makers: [
        {
            name: "@electron-forge/maker-squirrel",
            platforms: ["win32"],
            config: {
                // %LOCALAPPDATA%\sovereignbot install root on end-user machines.
                name: "sovereignbot",
                noMsi: true,
                // Required by the generated .nuspec; kept aligned with the repo owner.
                authors: "Kura-etnPL",
            },
        },
    ],
};
