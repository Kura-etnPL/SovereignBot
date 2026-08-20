import { lookup } from "node:dns/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import net from "node:net";

const METADATA_HOSTS = new Set([
    "169.254.169.254",
    "100.100.100.200",
    "metadata.google.internal",
]);

function normalizeHost(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "");
}

function ipv4Unsafe(host) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    return parts[0] === 0
        || parts[0] === 10
        || parts[0] === 127
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
        || parts[0] >= 224;
}

function ipv6Unsafe(host) {
    const value = normalizeHost(host);
    return value === "::"
        || value === "::1"
        || value.startsWith("fc")
        || value.startsWith("fd")
        || /^fe[89ab]/.test(value)
        || value.startsWith("ff");
}

export function isUnsafeAddress(address) {
    const normalized = normalizeHost(address);
    const family = isIP(normalized);
    if (family === 4)
        return ipv4Unsafe(normalized);
    if (family === 6)
        return ipv6Unsafe(normalized);
    return true;
}

export function isBlockedHost(host) {
    const normalized = normalizeHost(host);
    return METADATA_HOSTS.has(normalized)
        || normalized === "localhost"
        || normalized.endsWith(".localhost")
        || normalized.endsWith(".local");
}

export async function resolveEgressTarget(host, { allowPrivateHosts = false } = {}) {
    const normalized = normalizeHost(host);
    if (!normalized)
        throw new Error("egress target host is empty");
    if (METADATA_HOSTS.has(normalized))
        throw new Error("cloud metadata egress is always blocked");
    if (!allowPrivateHosts && isBlockedHost(normalized))
        throw new Error(`private/local egress target is blocked: ${normalized}`);

    const literalFamily = isIP(normalized);
    const results = literalFamily
        ? [{ address: normalized, family: literalFamily }]
        : await lookup(normalized, { all: true, verbatim: true });
    if (!results.length)
        throw new Error(`egress DNS returned no addresses for ${normalized}`);

    if (!allowPrivateHosts) {
        const unsafe = results.find((entry) => isUnsafeAddress(entry.address));
        if (unsafe)
            throw new Error(`egress target resolved to a blocked address: ${unsafe.address}`);
    }
    else {
        const metadata = results.find((entry) => normalizeHost(entry.address) === "169.254.169.254");
        if (metadata)
            throw new Error("cloud metadata egress is always blocked");
    }

    // Connect to the concrete address we just validated instead of asking the OS to resolve the
    // hostname a second time. This closes the obvious DNS-rebinding gap between policy and connect.
    return { host: normalized, ...results[0] };
}

function parseAuthority(value, defaultPort) {
    const text = String(value ?? "");
    const url = new URL(`http://${text}`);
    return {
        host: normalizeHost(url.hostname),
        port: Number(url.port || defaultPort),
    };
}

function filteredHeaders(headers, hostHeader) {
    const next = { ...headers, host: hostHeader };
    delete next["proxy-authorization"];
    delete next["proxy-connection"];
    return next;
}

export async function startEgressProxy({ allowPrivateHosts = false } = {}) {
    const server = createHttpServer(async (request, response) => {
        try {
            const targetUrl = new URL(request.url ?? "");
            if (targetUrl.protocol !== "http:")
                throw new Error("plain proxy requests must use http");
            const target = await resolveEgressTarget(targetUrl.hostname, { allowPrivateHosts });
            const upstream = httpRequest({
                host: target.address,
                family: target.family,
                port: Number(targetUrl.port || 80),
                method: request.method,
                path: `${targetUrl.pathname}${targetUrl.search}`,
                headers: filteredHeaders(request.headers, targetUrl.host),
            }, (upstreamResponse) => {
                response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
                upstreamResponse.pipe(response);
            });
            upstream.on("error", (error) => {
                if (!response.headersSent)
                    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
                response.end(`egress proxy upstream failed: ${error.message}`);
            });
            request.pipe(upstream);
        }
        catch (error) {
            response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            response.end(`egress refused: ${error.message}`);
        }
    });

    server.on("connect", async (request, clientSocket, head) => {
        try {
            const authority = parseAuthority(request.url, 443);
            const target = await resolveEgressTarget(authority.host, { allowPrivateHosts });
            const upstream = net.connect({ host: target.address, family: target.family, port: authority.port });
            upstream.once("connect", () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head?.length)
                    upstream.write(head);
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
            upstream.once("error", () => clientSocket.destroy());
            clientSocket.once("error", () => upstream.destroy());
        }
        catch {
            clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        }
    });

    server.on("upgrade", async (request, socket, head) => {
        let upstream;
        try {
            const targetUrl = new URL(request.url ?? "");
            const target = await resolveEgressTarget(targetUrl.hostname, { allowPrivateHosts });
            upstream = net.connect({
                host: target.address,
                family: target.family,
                port: Number(targetUrl.port || 80),
            });
            upstream.once("connect", () => {
                const lines = [
                    `${request.method} ${targetUrl.pathname}${targetUrl.search} HTTP/${request.httpVersion}`,
                    ...Object.entries(filteredHeaders(request.headers, targetUrl.host)).map(([key, value]) => `${key}: ${value}`),
                    "",
                    "",
                ];
                upstream.write(lines.join("\r\n"));
                if (head?.length)
                    upstream.write(head);
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.once("error", () => socket.destroy());
            socket.once("error", () => upstream.destroy());
        }
        catch {
            upstream?.destroy();
            socket.destroy();
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("egress proxy did not receive a TCP port");

    return {
        host: "127.0.0.1",
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}
