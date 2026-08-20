import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const chunks = [];
for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
const bootstrap = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (bootstrap.protocol !== "sovereignbot.sidecar.v1" || typeof bootstrap.token !== "string")
    throw new Error("invalid test sidecar bootstrap");
const token = bootstrap.token;
const processLease = "env-fixture-process-lease";
const sessionLease = "env-fixture-session-lease";

function sameToken(value) {
    const a = Buffer.from(token);
    const b = Buffer.from(value ?? "");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function send(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
    });
    response.end(body);
}

const server = createServer((request, response) => {
    const header = request.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameToken(supplied)) {
        send(response, 401, { error: "unauthorized" });
        return;
    }
    if (request.method === "GET" && request.url === "/health") {
        send(response, 200, {
            ok: true,
            protocol: "sovereignbot.sidecar.v1",
            processLease,
            sessionLease,
            sessionActive: true,
            leakedParentSecret: Boolean(process.env.SOVEREIGNBOT_PARENT_SECRET_TEST),
            leakedTransportToken: Boolean(process.env.SOVEREIGNBOT_SIDECAR_TOKEN),
            explicitEnv: process.env.EXPLICIT_SIDE_ENV ?? null,
        });
        return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
        send(response, 200, { shuttingDown: true });
        queueMicrotask(() => server.close(() => process.exit(0)));
        return;
    }
    send(response, 404, { error: "not found" });
});

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
process.stdout.write(`${JSON.stringify({
    protocol: "sovereignbot.sidecar.v1",
    host: "127.0.0.1",
    port: address.port,
    processLease,
    sessionLease,
    browser: "fixture",
})}\n`);
