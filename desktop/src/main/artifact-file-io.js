import { copyFile, lstat, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

const MAX_ARTIFACT_EXPORT_BYTES = 50 * 1024 * 1024;

function safeFileStem(value) {
    const stem = String(value ?? "artifact")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return stem || "artifact";
}

function defaultFileName(artifact) {
    const extension = extname(String(artifact?.fileName ?? ""));
    return safeFileStem(artifact?.title || artifact?.fileName) + extension;
}

export async function exportArtifactViaDialog({ parentWindow, dialog, artifactStore, artifactId, copyFileFn = copyFile, lstatFn = lstat, statFn = stat } = {}) {
    if (!artifactStore || typeof artifactStore.get !== "function" || typeof artifactStore.managedPath !== "function")
        throw new Error("artifact export requires the managed artifact store");
    const artifact = artifactStore.get(artifactId);
    const sourcePath = artifactStore.managedPath(artifactId);
    const sourceLstat = await lstatFn(sourcePath);
    if (sourceLstat.isSymbolicLink()) throw new Error("artifact source may not be a symbolic link");
    const sourceStat = await statFn(sourcePath);
    if (!sourceStat.isFile()) throw new Error("artifact source is not a regular managed file");
    if (sourceStat.size < 0 || sourceStat.size > MAX_ARTIFACT_EXPORT_BYTES)
        throw new Error(`artifact export exceeds ${MAX_ARTIFACT_EXPORT_BYTES} bytes`);

    const selected = await dialog.showSaveDialog(parentWindow, {
        title: "Export Artifact Copy",
        defaultPath: defaultFileName(artifact),
        filters: [{ name: "Artifact files", extensions: [String(artifact.fileName).split(".").pop() || "bin"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    try {
        await copyFileFn(sourcePath, selected.filePath);
    } catch {
        throw new Error("Could not save the Artifact copy");
    }
    return {
        canceled: false,
        fileName: basename(selected.filePath),
        bytes: sourceStat.size,
        artifactId: artifact.id,
        version: artifact.version ?? 1,
    };
}
