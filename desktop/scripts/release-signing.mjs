import { existsSync, statSync } from "node:fs";

const MODES = new Set(["rc", "stable"]);

export function releaseSigningConfig(env = process.env) {
    const mode = env.SOVEREIGNBOT_RELEASE_MODE ?? "rc";
    if (!MODES.has(mode)) throw new Error("SOVEREIGNBOT_RELEASE_MODE must be rc or stable");
    const certificateFile = env.SOVEREIGNBOT_WINDOWS_CERTIFICATE_FILE;
    const certificatePassword = env.SOVEREIGNBOT_WINDOWS_CERTIFICATE_PASSWORD;
    const signToolPath = env.SOVEREIGNBOT_WINDOWS_SIGNTOOL;
    const signWithParams = env.SOVEREIGNBOT_WINDOWS_SIGN_WITH_PARAMS;
    const hasCertificate = Boolean(certificateFile && certificatePassword);
    if (mode === "stable" && !hasCertificate)
        throw new Error("stable release requires SOVEREIGNBOT_WINDOWS_CERTIFICATE_FILE and SOVEREIGNBOT_WINDOWS_CERTIFICATE_PASSWORD");
    if (hasCertificate && (!existsSync(certificateFile) || !statSync(certificateFile).isFile()))
        throw new Error("configured Windows certificate file is missing or not a regular file");
    if (mode === "stable" && signToolPath && (!existsSync(signToolPath) || !statSync(signToolPath).isFile()))
        throw new Error("configured Windows signing tool is missing or not a regular file");
    return {
        mode,
        status: hasCertificate ? "signed" : "unsigned",
        // Only Forge receives secrets; manifest/UI projections use status above.
        makerConfig: hasCertificate ? {
            certificateFile,
            certificatePassword,
            ...(signToolPath ? { signToolPath } : {}),
            ...(signWithParams ? { signWithParams } : {}),
        } : {},
    };
}

export function publicSigningStatus(env = process.env) {
    const config = releaseSigningConfig(env);
    return { mode: config.mode, status: config.status, authenticodeVerification: "not-run" };
}
