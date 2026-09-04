import { existsSync, readdirSync, statSync, mkdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Safely migrates legacy `dataDir/provider-profiles` into `dataDir/desktop-state/provider-profiles`.
 * Core's startup-preflight strictly enforces allowed top-level directories in dataDir.
 * All desktop-layer provider profiles belong under `desktop-state/provider-profiles`.
 *
 * @param {{ dataDir: string }} options
 * @returns {{ migrated: boolean, moved: number }}
 */
export function migrateProviderProfiles({ dataDir } = {}) {
    if (!dataDir) return { migrated: false, moved: 0 };
    const root = resolve(dataDir);
    const legacyPath = join(root, "provider-profiles");

    if (!existsSync(legacyPath)) {
        return { migrated: false, moved: 0 };
    }

    try {
        const legacyStat = statSync(legacyPath);
        if (!legacyStat.isDirectory()) {
            return { migrated: false, moved: 0 };
        }
    } catch {
        return { migrated: false, moved: 0 };
    }

    const targetRoot = join(root, "desktop-state", "provider-profiles");
    mkdirSync(targetRoot, { recursive: true });

    let moved = 0;
    const entries = readdirSync(legacyPath);

    for (const entry of entries) {
        const sourceEntry = join(legacyPath, entry);
        const targetEntry = join(targetRoot, entry);

        if (!existsSync(targetEntry)) {
            try {
                renameSync(sourceEntry, targetEntry);
                moved++;
                continue;
            } catch {
                cpSync(sourceEntry, targetEntry, { recursive: true });
                rmSync(sourceEntry, { recursive: true, force: true });
                moved++;
                continue;
            }
        }

        // If target already exists, merge contents non-destructively
        try {
            const subStat = statSync(sourceEntry);
            if (subStat.isDirectory()) {
                mkdirSync(targetEntry, { recursive: true });
                const subEntries = readdirSync(sourceEntry);
                for (const sub of subEntries) {
                    const srcSub = join(sourceEntry, sub);
                    const tgtSub = join(targetEntry, sub);
                    if (!existsSync(tgtSub)) {
                        try {
                            renameSync(srcSub, tgtSub);
                            moved++;
                        } catch {
                            cpSync(srcSub, tgtSub, { recursive: true });
                            rmSync(srcSub, { recursive: true, force: true });
                            moved++;
                        }
                    } else {
                        // Account directory exists in both, merge files without overwriting existing
                        cpSync(srcSub, tgtSub, { recursive: true, force: false });
                        rmSync(srcSub, { recursive: true, force: true });
                        moved++;
                    }
                }
                rmSync(sourceEntry, { recursive: true, force: true });
            } else {
                if (!existsSync(targetEntry)) {
                    renameSync(sourceEntry, targetEntry);
                } else {
                    rmSync(sourceEntry, { force: true });
                }
                moved++;
            }
        } catch {
            // Best-effort cleanup per entry
        }
    }

    // Clean up the legacy top-level directory so startup-preflight passes
    try {
        if (existsSync(legacyPath)) {
            const remaining = readdirSync(legacyPath);
            if (remaining.length === 0) {
                rmSync(legacyPath, { recursive: true, force: true });
            }
        }
    } catch {
        // Ignored
    }

    return { migrated: true, moved };
}
