import { ComputerActionRefusedError } from "./computer-gateway.js";

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (!chunks.length)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, value) {
    const body = JSON.stringify(value, null, 2);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
    });
    response.end(body);
}

function bearer(request) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer "))
        return undefined;
    return header.slice("Bearer ".length).trim() || undefined;
}

function segments(pathname) {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

async function requireAgent(runtime, request, response, agentId) {
    if (await runtime.computer.authenticateAgent(agentId, bearer(request)))
        return true;
    send(response, 401, { error: "invalid or missing agent computer token" });
    return false;
}

async function requireOperator(runtime, request, response) {
    if (await runtime.computer.authenticateOperator(bearer(request)))
        return true;
    send(response, 401, { error: "invalid or missing operator computer token" });
    return false;
}

export async function handleComputerApiRequest(runtime, request, response, url) {
    const parts = segments(url.pathname);
    try {
        if (request.method === "GET" && parts.length === 1 && parts[0] === "computers") {
            if (!(await requireOperator(runtime, request, response)))
                return;
            send(response, 200, await runtime.computer.listComputers());
            return;
        }

        if (parts[0] !== "computers" || !parts[1]) {
            send(response, 404, { error: "not found" });
            return;
        }
        const agentId = parts[1];

        if (request.method === "GET" && parts[2] === "control" && parts.length === 3) {
            if (!(await requireOperator(runtime, request, response)))
                return;
            send(response, 200, await runtime.computer.control(agentId));
            return;
        }

        if (request.method === "POST" && parts[2] === "control" && parts[3] === "take" && parts.length === 4) {
            if (!(await requireOperator(runtime, request, response)))
                return;
            const body = await readBody(request);
            send(response, 200, await runtime.computer.takeControl(agentId, body.actorId));
            return;
        }

        if (request.method === "POST" && parts[2] === "control" && parts[3] === "release" && parts.length === 4) {
            if (!(await requireOperator(runtime, request, response)))
                return;
            const body = await readBody(request);
            send(response, 200, await runtime.computer.releaseControl(agentId, body.actorId));
            return;
        }

        if (
            request.method === "POST"
            && parts[2] === "secrets"
            && parts[3]
            && parts[4] === "supply"
            && parts.length === 5
        ) {
            if (!(await requireOperator(runtime, request, response)))
                return;
            const body = await readBody(request);
            send(
                response,
                200,
                await runtime.computer.supplySecret(agentId, body.actorId, parts[3], String(body.value ?? "")),
            );
            return;
        }

        if (!(await requireAgent(runtime, request, response, agentId)))
            return;
        if (request.method !== "POST") {
            send(response, 405, { error: "method not allowed" });
            return;
        }

        const body = await readBody(request);
        const taskId = body.taskId;
        if (!taskId)
            throw new Error("computer action requires taskId");

        if (parts.length === 3 && parts[2] === "snapshot") {
            send(response, 200, await runtime.computer.snapshot(agentId, taskId));
            return;
        }
        if (parts.length === 3 && parts[2] === "navigate") {
            send(response, 200, await runtime.computer.navigate(agentId, taskId, body.url));
            return;
        }
        if (parts.length === 3 && parts[2] === "click") {
            send(response, 200, await runtime.computer.click(agentId, taskId, body));
            return;
        }
        if (parts.length === 3 && parts[2] === "type") {
            send(response, 200, await runtime.computer.type(agentId, taskId, body));
            return;
        }
        if (parts.length === 3 && parts[2] === "key") {
            send(response, 200, await runtime.computer.key(agentId, taskId, body));
            return;
        }
        if (parts.length === 3 && parts[2] === "scroll") {
            send(response, 200, await runtime.computer.scroll(agentId, taskId, body));
            return;
        }
        if (parts.length === 4 && parts[2] === "files" && parts[3] === "list") {
            send(response, 200, await runtime.computer.listFiles(agentId, taskId, body.path ?? "."));
            return;
        }
        if (parts.length === 4 && parts[2] === "files" && parts[3] === "read") {
            send(response, 200, {
                path: body.path,
                encoding: body.encoding ?? "utf8",
                content: await runtime.computer.readFile(agentId, taskId, body),
            });
            return;
        }
        if (parts.length === 4 && parts[2] === "files" && parts[3] === "write") {
            send(response, 200, await runtime.computer.writeFile(agentId, taskId, body));
            return;
        }
        if (parts.length === 3 && parts[2] === "help") {
            send(response, 200, await runtime.computer.requestHelp(agentId, taskId, body.reason));
            return;
        }
        if (parts.length === 3 && parts[2] === "secret-request") {
            send(response, 201, await runtime.computer.requestSecret(agentId, taskId, body));
            return;
        }

        send(response, 404, { error: "not found" });
    }
    catch (error) {
        if (error instanceof ComputerActionRefusedError) {
            send(response, 403, {
                error: error.message,
                ruleId: error.decision?.ruleId,
                repeatCount: error.decision?.repeatCount,
            });
            return;
        }
        send(response, 400, { error: error.message });
    }
}
