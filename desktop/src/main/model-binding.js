// Product-level model selection.  This is intentionally a small data contract: it
// describes a coworker's preference, but never grants execution authority.

export const MODEL_PROFILES = Object.freeze(["automatic", "efficient", "deep", "economy", "custom"]);
export const MODEL_PROVIDERS = Object.freeze(["codex", "claude", "antigravity", "chatgpt-web"]);

const PROFILE_SET = new Set(MODEL_PROFILES);
const PROVIDER_SET = new Set(MODEL_PROVIDERS);
const LEGACY_SET = new Set(["auto", "codex", "claude"]);

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeOpaqueId(value, label, max = 128) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\\/\0\r\n]/.test(value))
        throw new Error(`${label} must be a safe opaque identifier`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
        throw new Error(`${label} must be a safe opaque identifier`);
    return value;
}

function safeModel(value) {
    if (value === undefined || value === null)
        return undefined;
    return safeOpaqueId(value, "model");
}

function providerPreferenceFor(binding) {
    if (binding?.provider === "codex") return "codex";
    if (binding?.provider === "claude") return "claude";
    return "auto";
}

export function modelBindingFromLegacy(providerPreference = "auto") {
    if (!LEGACY_SET.has(providerPreference))
        throw new Error("providerPreference must be one of: auto, codex, claude");
    if (providerPreference === "codex")
        return { profile: "efficient", provider: "codex", model: "luna" };
    if (providerPreference === "claude")
        return { profile: "automatic", provider: "claude" };
    return { profile: "automatic" };
}

export function normalizeModelBinding(value, { legacyPreference = "auto" } = {}) {
    if (value === undefined || value === null)
        return modelBindingFromLegacy(legacyPreference);
    if (!isPlainObject(value))
        throw new Error("modelBinding must be an object");

    const allowed = new Set(["profile", "provider", "providerAccountId", "model"]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error(`unknown modelBinding field: ${key}`);
    }
    const profile = value.profile ?? "automatic";
    if (!PROFILE_SET.has(profile))
        throw new Error(`modelBinding.profile must be one of: ${MODEL_PROFILES.join(", ")}`);
    let provider;
    if (value.provider !== undefined) {
        if (typeof value.provider !== "string" || !PROVIDER_SET.has(value.provider))
            throw new Error(`modelBinding.provider must be one of: ${MODEL_PROVIDERS.join(", ")}`);
        provider = value.provider;
    }
    const providerAccountId = value.providerAccountId === undefined
        ? undefined
        : safeOpaqueId(value.providerAccountId, "modelBinding.providerAccountId");
    const model = safeModel(value.model);
    if (profile === "custom" && (!provider || !model))
        throw new Error("custom modelBinding requires provider and model");
    if (profile === "automatic" && !provider && model)
        throw new Error("automatic modelBinding cannot pin a model without a provider");
    return {
        profile,
        ...(provider ? { provider } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
        ...(model ? { model } : {}),
    };
}

// Renderer-facing data contains only the human-level profile.  Provider/account/model
// details remain main-process state even when the renderer asks for a coworker list.
export function publicModelBinding(binding) {
    const normalized = normalizeModelBinding(binding);
    return { profile: normalized.profile };
}

export function modelBindingProviderPreference(binding) {
    return providerPreferenceFor(normalizeModelBinding(binding));
}

export function modelBindingProfile(binding) {
    return normalizeModelBinding(binding).profile;
}
