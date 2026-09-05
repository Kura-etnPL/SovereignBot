#!/usr/bin/env node
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { startEgressProxy, resolveEgressTarget } from "./egress-proxy.js";
import { captureWebDriverFrame } from "./screenshot.js";
import { WebDriverClient } from "./webdriver-client.js";
import { startWebDriverProcess } from "./webdriver-process.js";

const PROTOCOL = "sovereignbot.sidecar.v1";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BOOTSTRAP_BYTES = 64 * 1024;

async function readBootstrap() {
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_BOOTSTRAP_BYTES)
            throw new Error("sidecar bootstrap payload is too large");
        chunks.push(buffer);
    }
    if (!chunks.length)
        throw new Error("sidecar bootstrap payload is required");
    let bootstrap;
    try {
        bootstrap = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new Error("sidecar bootstrap payload is not valid JSON");
    }
    if (bootstrap?.protocol !== PROTOCOL)
        throw new Error("sidecar bootstrap protocol mismatch");
    if (typeof bootstrap.token !== "string" || bootstrap.token.length < 24)
        throw new Error("sidecar bootstrap token is invalid");
    return bootstrap;
}

async function parseConfig() {
    const bootstrap = await readBootstrap();
    const raw = process.env.SOVEREIGNBOT_SIDECAR_CONFIG_JSON;
    let config = {};
    if (raw) {
        try {
            config = JSON.parse(raw);
        }
        catch {
            throw new Error("SOVEREIGNBOT_SIDECAR_CONFIG_JSON is not valid JSON");
        }
    }
    const profileDir = process.env.SOVEREIGNBOT_PROFILE_DIR;
    if (!profileDir)
        throw new Error("SOVEREIGNBOT_PROFILE_DIR is required");
    return {
        token: bootstrap.token,
        profileDir: resolve(profileDir),
        browser: config.browser ?? "chrome",
        headless: Boolean(config.headless),
        browserBinary: config.browserBinary,
        webdriverUrl: config.webdriverUrl,
        webdriverCommand: config.webdriverCommand,
        webdriverArgs: config.webdriverArgs,
        startupTimeoutMs: config.startupTimeoutMs ?? 20_000,
        requestTimeoutMs: config.requestTimeoutMs ?? 30_000,
        allowPrivateHosts: Boolean(config.allowPrivateHosts),
    };
}

function bearer(request) {
    const value = request.headers.authorization;
    return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

function tokenEqual(expected, actual) {
    const a = Buffer.from(expected);
    const b = Buffer.from(actual);
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readJson(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_BODY_BYTES)
            throw new Error("sidecar request body is too large");
        chunks.push(buffer);
    }
    if (!chunks.length)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
    });
    response.end(body);
}

function safeError(error) {
    const message = error instanceof Error ? error.message : "sidecar operation failed";
    return message.replace(/[\r\n]+/g, " ").slice(0, 1400);
}

async function main() {
    const config = await parseConfig();
    await mkdir(config.profileDir, { recursive: true });

    const proxy = await startEgressProxy({ allowPrivateHosts: config.allowPrivateHosts });
    let webdriver;
    try {
        webdriver = await startWebDriverProcess({
            browser: config.browser,
            endpoint: config.webdriverUrl,
            command: config.webdriverCommand,
            args: config.webdriverArgs,
            startupTimeoutMs: config.startupTimeoutMs,
        });
    }
    catch (error) {
        await proxy.close().catch(() => undefined);
        throw error;
    }

    let client;
    let sessionLease;
    let handles = new Map();
    let server;
    let shuttingDown = false;
    const processLease = randomUUID();

    async function startSession() {
        if (client?.sessionId)
            return;
        client = new WebDriverClient({
            endpoint: webdriver.endpoint,
            profileDir: config.profileDir,
            browser: config.browser,
            headless: config.headless,
            proxyUrl: proxy.url,
            browserBinary: config.browserBinary,
            timeoutMs: Math.max(config.requestTimeoutMs, config.startupTimeoutMs),
        });
        await client.start();
        sessionLease = randomUUID();
        handles = new Map();
    }

    async function stopSession() {
        handles = new Map();
        sessionLease = undefined;
        if (client) {
            await client.quit();
            client = undefined;
        }
    }

    async function resetSession() {
        await stopSession();
        await rm(config.profileDir, { recursive: true, force: true });
        await mkdir(config.profileDir, { recursive: true });
        await startSession();
    }

    function requireLease(body) {
        if (!sessionLease || body?.leaseId !== sessionLease)
            throw new Error("sidecar browser lease is stale; take a fresh snapshot");
    }

    function elementId(body) {
        requireLease(body);
        const value = handles.get(body?.handle);
        if (!value)
            throw new Error("sidecar element handle is stale or unknown");
        return value;
    }

    try {
        await startSession();
    }
    catch (error) {
        await webdriver.close().catch(() => undefined);
        await proxy.close().catch(() => undefined);
        throw error;
    }

    server = createServer(async (request, response) => {
        if (!tokenEqual(config.token, bearer(request))) {
            send(response, 401, { error: "unauthorized" });
            return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const secretRoute = url.pathname === "/type-secret";
        try {
            if (request.method === "GET" && url.pathname === "/health") {
                send(response, 200, {
                    ok: true,
                    protocol: PROTOCOL,
                    processLease,
                    sessionLease: sessionLease ?? null,
                    sessionActive: Boolean(client?.sessionId),
                    browser: config.browser,
                    webdriverExternal: webdriver.external,
                });
                return;
            }

            if (request.method === "GET" && url.pathname === "/frame") {
                if (!client?.sessionId || !sessionLease) {
                    send(response, 409, { error: "computer browser session is not running" });
                    return;
                }
                const frame = await captureWebDriverFrame({
                    endpoint: webdriver.endpoint,
                    sessionId: client.sessionId,
                    timeoutMs: Math.min(config.requestTimeoutMs, 15_000),
                });
                send(response, 200, {
                    ...frame,
                    leaseId: sessionLease,
                    url: await client.currentUrl(),
                    capturedAt: new Date().toISOString(),
                });
                return;
            }

            if (request.method === "POST" && url.pathname === "/start") {
                await startSession();
                send(response, 200, { started: true, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/stop") {
                await stopSession();
                send(response, 200, { stopped: true });
                return;
            }

            if (request.method === "POST" && url.pathname === "/reset") {
                await resetSession();
                send(response, 200, { reset: true, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/snapshot") {
                await startSession();
                const snapshot = await client.snapshot();
                handles = new Map();
                const elements = snapshot.elements.map((element, index) => {
                    const handle = randomBytes(24).toString("base64url");
                    handles.set(handle, element.elementId);
                    return {
                        ref: `e${index + 1}`,
                        handle,
                        role: element.role,
                        name: element.name,
                        type: element.type,
                        disabled: element.disabled,
                    };
                });
                send(response, 200, {
                    leaseId: sessionLease,
                    url: snapshot.url,
                    title: snapshot.title,
                    elements,
                });
                return;
            }

            if (request.method === "POST" && url.pathname === "/text") {
                await startSession();
                send(response, 200, { text: await client.visibleText(), leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/chatgpt-page") {
                await startSession();
                send(response, 200, { page: await client.chatGPTPage(), leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/navigate") {
                const body = await readJson(request);
                const target = new URL(String(body.url));
                await resolveEgressTarget(target.hostname, { allowPrivateHosts: config.allowPrivateHosts });
                await startSession();
                const result = await client.navigate(target.toString());
                handles = new Map();
                send(response, 200, { ...result, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/click") {
                const body = await readJson(request);
                const result = await client.click(elementId(body));
                send(response, 200, { ...result, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/type") {
                const body = await readJson(request);
                const result = await client.type(elementId(body), String(body.text ?? ""));
                send(response, 200, { ...result, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/type-secret") {
                const body = await readJson(request);
                const result = await client.type(elementId(body), String(body.text ?? ""));
                send(response, 200, { supplied: true, characters: result.characters, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/key") {
                const body = await readJson(request);
                requireLease(body);
                const element = body.handle ? handles.get(body.handle) : undefined;
                if (body.handle && !element)
                    throw new Error("sidecar element handle is stale or unknown");
                const result = await client.key(element, String(body.key ?? ""));
                send(response, 200, { ...result, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/scroll") {
                const body = await readJson(request);
                requireLease(body);
                const result = await client.scroll({ deltaX: Number(body.deltaX ?? 0), deltaY: Number(body.deltaY ?? 0) });
                send(response, 200, { ...result, leaseId: sessionLease });
                return;
            }

            if (request.method === "POST" && url.pathname === "/shutdown") {
                send(response, 200, { shuttingDown: true });
                queueMicrotask(() => shutdown());
                return;
            }

            send(response, 404, { error: "not found" });
        }
        catch (error) {
            send(response, 400, { error: secretRoute ? "secret input failed" : safeError(error) });
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("sidecar did not receive a TCP port");

    process.stdout.write(`${JSON.stringify({
        protocol: PROTOCOL,
        host: "127.0.0.1",
        port: address.port,
        processLease,
        sessionLease,
        browser: config.browser,
    })}\n`);

    async function shutdown() {
        if (shuttingDown)
            return;
        shuttingDown = true;
        try {
            await stopSession();
        }
        finally {
            await webdriver.close().catch(() => undefined);
            await proxy.close().catch(() => undefined);
            await new Promise((resolve) => server.close(() => resolve()));
        }
    }

    process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
    process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
}

main().catch((error) => {
    process.stderr.write(`SovereignBot WebDriver sidecar failed: ${safeError(error)}\n`);
    process.exitCode = 1;
});
