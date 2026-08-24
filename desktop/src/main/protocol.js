import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ASSETS, APP_HOST, APP_SCHEME } from "./lib/app-assets.js";

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));

// Registers the privileged app scheme. Must be called before app.ready via
// registerSchemesAsPrivileged; the handler itself is installed after ready.
export function registerAppSchemePrivileged() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: APP_SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                stream: true,
                codeCache: true,
            },
        },
    ]);
}

export function installAppProtocolHandler() {
    const handler = (request) => {
        const url = new URL(request.url);
        if (url.host !== APP_HOST)
            return notFound();
        const asset = APP_ASSETS[url.pathname];
        if (!asset)
            return notFound();
        return readFile(join(UI_DIR, asset.file))
            .then((body) => new Response(body, {
                status: 200,
                headers: {
                    "content-type": asset.type,
                    "cache-control": "no-store",
                    "x-content-type-options": "nosniff",
                },
            }))
            .catch(() => notFound());
    };
    protocol.handle(APP_SCHEME, handler);
    return () => {
        try {
            protocol.unhandle(APP_SCHEME);
        }
        catch {
        }
    };
}

function notFound() {
    return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
}
