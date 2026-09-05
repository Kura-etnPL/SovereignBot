import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpenCodeProviderAdapter } from "./opencode-provider.js";

// Read only the exact requested OpenCode credential. Never return it in public
// status, configuration, exceptions, or the renderer. No account mutations.
export function resolveOpenCodeCredential({ kind }, { env = process.env, home = homedir() } = {}) {
    const envKey = kind === "go" ? "SOVEREIGNBOT_OPENCODE_GO_KEY" : "SOVEREIGNBOT_OPENCODE_ZEN_KEY";
    if (env[envKey]) return env[envKey];
    try {
        const auth = JSON.parse(readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8"));
        const entry = auth[kind === "go" ? "opencode-go" : "opencode"];
        return entry?.type === "api" && typeof entry.key === "string" ? entry.key : undefined;
    } catch { return undefined; }
}

export function createOpenCodeAdapterFactory({ dataDir, credentialResolver = resolveOpenCodeCredential, transport, goBalanceFallbackDisabled = false } = {}) {
    return ({ providerId, mode, model, accountNamespace = "default" }) => {
        if (!["opencode-zen-free", "opencode-go"].includes(providerId)) return undefined;
        const kind = providerId === "opencode-go" ? "go" : "zen";
        if (mode !== (kind === "zen" ? "free" : "fixed-subscription"))
            throw new Error("OpenCode provider mode does not match its cost boundary");
        const adapter = createOpenCodeProviderAdapter({ providerId, kind, model, accountNamespace, dataDir, credentialResolver, ...(transport ? { transport } : {}) });
        if (kind === "go" && !goBalanceFallbackDisabled) {
            const blocked = () => { const error = new Error("OpenCode Go balance fallback must be confirmed disabled before use"); error.code = "BILLING_CONFIRMATION_REQUIRED"; throw error; };
            return { ...adapter, health: async () => ({ found: true, health: "unavailable", reason: "Confirm OpenCode Go Use balance is off before enabling execution." }), start: blocked, continue: blocked };
        }
        return adapter;
    };
}
