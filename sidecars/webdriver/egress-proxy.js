import { lookup } from "node:dns/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";
import net from "node:net";

const METADATA_HOSTS = new Set([
    "169.254.169.254",
    "100.100.100.200",
    "metadata.google.internal",
]);

const NEVER_ALLOW = new BlockList();
NEVER_ALLOW.addSubnet("0.0.0.0", 8, "ipv4");
NEVER_ALLOW.addSubnet("169.254.0.0", 16, "ipv4");
NEVER_ALLOW.addSubnet("192.0.0.0", 24, "ipv4");
NEVER_ALLOW.addSubnet("192.0.2.0", 24, "ipv4");
NEVER_ALLOW.addSubnet("198.18.0.0", 15, "ipv4");
NEVER_ALLOW.addSubnet("198.51.100.0", 24, "ipv4");
NEVER_ALLOW.addSubnet("203.0.113.0", 24, "ipv4");
NEVER_ALLOW.addSubnet("224.0.0.0", 4, "ipv4");
NEVER_ALLOW.addSubnet("240.0.0.0", 4, "ipv4");
NEVER_ALLOW.addAddress("::", "ipv6");
NEVER_ALLOW.addSubnet("fe80::", 10, "ipv6");
NEVER_ALLOW.addSubnet("ff00::", 8, "ipv6");
NEVER_ALLOW.addSubnet("2001:db8::", 32, "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

function normalizeHost(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "");
}

function mappedIpv4(address) {
    const match = normalizeHost(address).match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    return match?.[1];
}

function addressClass(address) {
    const normalized = normalizeHost(address);
    const mapped = mappedIpv4(normalized);
    if (mapped)
        return addressClass(mapped);
    const family = isIP(normalized);
    if (family === 4) {
        if (NEVER_ALLOW.check(normalized, "ipv4"))
            return "never";
        if (PRIVATE.check(normalized, "ipv4"))
            return "private";
        return "public";
    }
    if (family === 6) {
        if (NEVER_ALLOW.check(normalized, "ipv6"))
            return "never";
        if (PRIVATE.check(normalized, "ipv6"))
            return "private";
        return "public";
    }
    return "never";
}

export function isUnsafeAddress(address) {
    return addressClass(address) !== "public";
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

    for (const entry of results) {
        const classification = addressClass(entry.address);
        if (classification === "never")
            throw new Error(`egress target resolved to an always-blocked address: ${entry.address}`);
        if (classification === "private" && !allowPrivateHosts)
            throw new Error(`egress target resolved to a private/loopback address: ${entry.address}`);
    }

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
