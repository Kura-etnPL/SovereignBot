// Allowlisted assets for the sovereignbot://app custom protocol.
//
// Resolution is an exact-match lookup against this table, never a generic path-to-file
// mapping, so traversal, encoding tricks, NUL bytes, UNC/device paths, and unknown
// extensions are structurally impossible to express. Additions require a reviewed change.
export const APP_SCHEME = "sovereignbot";
export const APP_HOST = "app";

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const PNG = "image/png";
const SVG = "image/svg+xml";

export const APP_ASSETS = Object.freeze({
    "/": Object.freeze({ file: "index.html", type: HTML }),
    "/index.html": Object.freeze({ file: "index.html", type: HTML }),
    "/app.js": Object.freeze({ file: "app.js", type: JS }),
    "/style.css": Object.freeze({ file: "style.css", type: CSS }),
    "/artifacts-ui.js": Object.freeze({ file: "artifacts-ui.js", type: JS }),
    "/computer-ui.js": Object.freeze({ file: "computer-ui.js", type: JS }),
    "/live-screen-ui.js": Object.freeze({ file: "live-screen-ui.js", type: JS }),
    "/product-hubs-ui.js": Object.freeze({ file: "product-hubs-ui.js", type: JS }),
    "/skills-ui.js": Object.freeze({ file: "skills-ui.js", type: JS }),
    "/teach-ui.js": Object.freeze({ file: "teach-ui.js", type: JS }),
    "/chief-ui.js": Object.freeze({ file: "chief-ui.js", type: JS }),
    "/jobs-ui.js": Object.freeze({ file: "jobs-ui.js", type: JS }),
    "/triggers-ui.js": Object.freeze({ file: "triggers-ui.js", type: JS }),
    "/worker-nodes-ui.js": Object.freeze({ file: "worker-nodes-ui.js", type: JS }),
    "/i18n.js": Object.freeze({ file: "i18n.js", type: JS }),
    "/artifacts.css": Object.freeze({ file: "artifacts.css", type: CSS }),
    "/computer.css": Object.freeze({ file: "computer.css", type: CSS }),
    "/live-screen.css": Object.freeze({ file: "live-screen.css", type: CSS }),
    "/skills.css": Object.freeze({ file: "skills.css", type: CSS }),
    "/worker-nodes.css": Object.freeze({ file: "worker-nodes.css", type: CSS }),
});

export function resolveAppAsset(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl));
    }
    catch {
        return { ok: false, reason: "unparseable app url" };
    }
    if (parsed.protocol !== `${APP_SCHEME}:`)
        return { ok: false, reason: "unexpected protocol" };
    if (parsed.host !== APP_HOST || parsed.hostname !== APP_HOST)
        return { ok: false, reason: "unexpected host" };
    if (parsed.search || parsed.hash)
        return { ok: false, reason: "query/hash is not served over the app protocol" };
    if (parsed.pathname.includes("\0"))
        return { ok: false, reason: "NUL byte in app url" };
    const asset = APP_ASSETS[parsed.pathname];
    if (!asset)
        return { ok: false, reason: `unknown app asset: ${parsed.pathname}` };
    return { ok: true, pathname: parsed.pathname, file: asset.file, type: asset.type };
}

// True only for in-app navigations; everything else (https:, file:, about:blank excepted
// internally by Chromium) must be refused by will-navigate.
export function isAppUrl(value) {
    try {
        const parsed = new URL(String(value));
        return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
    }
    catch {
        return false;
    }
}

export const EXTERNAL_LINK_RULE = Object.freeze({
    // shell.openExternal is allowed only for https URLs whose path equals or lives under one
    // of these reviewed project prefixes; renderers never choose arbitrary targets.
    allowedPathPrefixes: Object.freeze(["/Kura-etnPL/SovereignBot"]),
});

export function isAllowedExternalUrl(value) {
    let parsed;
    try {
        parsed = new URL(String(value));
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "https:")
        return false;
    if (parsed.username || parsed.password)
        return false;
    if (parsed.hostname !== "github.com")
        return false;
    // Exact path or a real child segment only — a suffix like "@evil"/"../" must not ride
    // along on a prefix match.
    const { pathname } = parsed;
    return EXTERNAL_LINK_RULE.allowedPathPrefixes.some((prefix) =>
        pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export const APP_ICON_TYPES = Object.freeze({ PNG, SVG });
