import { createHash } from "node:crypto";

// ProviderAccount is an isolation identity, not a credential container.  The raw
// provider account identifier never needs to leave the main process; a one-way namespace
// is enough to keep continuity/routing state sticky to the selected account.
export function accountIsolationNamespace(provider, providerAccountId) {
    if (typeof provider !== "string" || typeof providerAccountId !== "string" || !providerAccountId)
        return undefined;
    return `provider-account-${createHash("sha256").update(`${provider}\0${providerAccountId}`).digest("hex").slice(0, 32)}`;
}

export function accountAffinityChanged(previousNamespace, nextNamespace) {
    return Boolean(previousNamespace || nextNamespace) && previousNamespace !== nextNamespace;
}
