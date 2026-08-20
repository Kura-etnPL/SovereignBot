import { isIP } from "node:net";
import { createId } from "./id.js";
import { ComputerWorkspace, describeWorkspacePath, resolveWorkspacePath } from "./computer-workspace.js";
import { UnavailableComputerDriver } from "./computer-driver.js";

const METADATA_HOSTS = new Set([
    "169.254.169.254",
    "100.100.100.200",
    "metadata.google.internal",
    "metadata.google.internal.",
]);
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

export class ComputerActionRefusedError extends Error {
    constructor(message, decision) {
        super(message);
        this.name = "ComputerActionRefusedError";
        this.decision = decision;
    }
}

function ipv4Private(host) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return false;
    return parts[0] === 10
        || parts[0] === 127
        || (parts[0] === 169 && parts[1] === 254)
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168)
        || parts[0] === 0;
}

function ipv6Private(host) {
    const value = host.toLowerCase().replace(/^\[|\]$/g, "");
    return value === "::1"
        || value === "::"
        || value.startsWith("fc")
        || value.startsWith("fd")
        || /^fe[89ab]/.test(value);
}

function privateHost(host) {
    const normalized = host.toLowerCase().replace(/\.$/, "");
    if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local"))
        return true;
    const family = isIP(normalized);
    return family === 4 ? ipv4Private(normalized) : family === 6 ? ipv6Private(normalized) : false;
}

function pageOf(url) {
    if (!url)
        return undefined;
    try {
        const parsed = new URL(url);
        return { url: parsed.toString(), host: parsed.hostname.toLowerCase() };
    }
    catch {
        return { url: String(url), host: "" };
    }
}

function safeAuditSubject(value) {
    if (!value || typeof value !== "string")
        return value;
    try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol))
            return value;
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
    }
    catch {
        return value;
    }
}

export function validateNavigationTarget(value, allowPrivateHosts = false) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return { ok: false, reason: "navigation target is not a valid URL" };
    }
    if (!["http:", "https:"].includes(parsed.protocol))
        return { ok: false, reason: "navigation allows only http/https URLs" };
    if (parsed.username || parsed.password)
        return { ok: false, reason: "credentials in navigation URLs are not allowed" };
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (METADATA_HOSTS.has(host))
        return { ok: false, reason: "cloud metadata targets are always blocked" };
    if (!allowPrivateHosts && privateHost(host))
        return { ok: false, reason: "private/loopback navigation target is not allowed" };
    return { ok: true, url: parsed.toString(), page: { url: parsed.toString(), host } };
}

function publicElement(element) {
    return {
        ref: element.ref,
        role: element.role,
        name: element.name,
        type: element.type,
    };
}

function keyIntent(key) {
    return ACTIVATING_KEYS.has(key) ? "activate" : "type";
}

function workspaceSubject(path) {
    return describeWorkspacePath(String(path ?? ".").replace(/\\/g, "/"));
}

export class ComputerGateway {
    #registry;
    #governor;
    #audit;
    #driverFactory;
    #allowPrivateHosts;
    #drivers = new Map();
    #workspaces = new Map();
    #snapshots = new Map();

    constructor({ registry, governor, audit, driverFactory, allowPrivateHosts = false }) {
        this.#registry = registry;
        this.#governor = governor;
        this.#audit = audit;
        this.#driverFactory = driverFactory;
        this.#allowPrivateHosts = allowPrivateHosts;
    }

    async listComputers() {
        return this.#registry.list();
    }

    async agentCredentials(agentId) {
        return this.#registry.credentials(agentId);
    }

    async operatorCredentials() {
        return this.#registry.operatorCredentials();
    }

    async authenticateAgent(agentId, token) {
        return this.#registry.authenticate(agentId, token);
    }

    async authenticateOperator(token) {
        return this.#registry.authenticateOperator(token);
    }

    async control(agentId) {
        return this.#registry.control(agentId);
    }

    async snapshot(agentId, taskId) {
        const cached = this.#snapshots.get(agentId);
        const result = await this.#govern(
            agentId,
            taskId,
            {
                operation: "snapshot",
                intent: "read",
                target: cached?.url ?? "about:blank",
                page: pageOf(cached?.url),
            },
            async () => (await this.#driver(agentId)).snapshot(),
        );
        if (!result || !Array.isArray(result.elements))
            throw new Error("computer driver snapshot must return an elements array");

        const seen = new Set();
        const elements = new Map();
        for (const element of result.elements) {
            if (!element?.ref || typeof element.ref !== "string")
                throw new Error("computer driver snapshot element is missing a string ref");
            if (seen.has(element.ref))
                throw new Error(`computer driver snapshot contains duplicate ref: ${element.ref}`);
            seen.add(element.ref);
            elements.set(element.ref, structuredClone(element));
        }
        const snapshot = {
            id: createId("snapshot"),
            agentId,
            url: result.url ?? cached?.url ?? "about:blank",
            elements,
            createdAt: new Date().toISOString(),
        };
        this.#snapshots.set(agentId, snapshot);
        return {
            snapshotId: snapshot.id,
            url: snapshot.url,
            elements: [...elements.values()].map(publicElement),
        };
    }

    async navigate(agentId, taskId, url) {
        const guard = validateNavigationTarget(url, this.#allowPrivateHosts);
        const result = await this.#govern(
            agentId,
            taskId,
            {
                operation: "navigate",
                intent: "navigate",
                target: guard.ok ? guard.url : String(url),
                page: guard.ok ? guard.page : undefined,
                hardDeny: guard.ok ? undefined : guard.reason,
            },
            async () => (await this.#driver(agentId)).navigate(guard.url),
        );
        this.#snapshots.delete(agentId);
        return result;
    }

    async click(agentId, taskId, input) {
        const resolved = this.#resolveElement(agentId, input);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "click",
                intent: "activate",
                target: input.ref,
                page: resolved.page,
                element: resolved.element ? publicElement(resolved.element) : undefined,
                hardDeny: resolved.reason,
            },
            async () => (await this.#driver(agentId)).click({ element: resolved.element }),
        );
    }

    async type(agentId, taskId, input) {
        const resolved = this.#resolveElement(agentId, input);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "type",
                intent: "type",
                target: input.ref,
                page: resolved.page,
                element: resolved.element ? publicElement(resolved.element) : undefined,
                hardDeny: resolved.reason,
            },
            async () => (await this.#driver(agentId)).type({ element: resolved.element, text: input.text }),
        );
    }

    async key(agentId, taskId, input) {
        const resolved = input.ref ? this.#resolveElement(agentId, input) : this.#currentPage(agentId);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "key",
                intent: keyIntent(input.key),
                target: input.ref ?? input.key,
                page: resolved.page,
                element: resolved.element ? publicElement(resolved.element) : undefined,
                key: input.key,
                hardDeny: resolved.reason,
            },
            async () => (await this.#driver(agentId)).key({ element: resolved.element, key: input.key }),
        );
    }

    async scroll(agentId, taskId, input) {
        const current = this.#currentPage(agentId);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "scroll",
                intent: "read",
                target: current.page?.url ?? "page",
                page: current.page,
                hardDeny: current.reason,
            },
            async () => (await this.#driver(agentId)).scroll(input),
        );
    }

    async listFiles(agentId, taskId, path = ".") {
        const subject = await this.#workspacePolicySubject(agentId, path);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "list_files",
                intent: "list_files",
                target: String(path),
                file: subject.file,
                hardDeny: subject.reason,
            },
            async () => (await this.#workspace(agentId)).list(path),
        );
    }

    async readFile(agentId, taskId, input) {
        const subject = await this.#workspacePolicySubject(agentId, input.path);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "read_file",
                intent: "read_file",
                target: String(input.path),
                file: subject.file,
                hardDeny: subject.reason,
            },
            async () => (await this.#workspace(agentId)).read(input.path, input.encoding),
        );
    }

    async writeFile(agentId, taskId, input) {
        const subject = await this.#workspacePolicySubject(agentId, input.path);
        return this.#govern(
            agentId,
            taskId,
            {
                operation: "write_file",
                intent: "write_file",
                target: String(input.path),
                file: subject.file,
                hardDeny: subject.reason,
            },
            async () => (await this.#workspace(agentId)).write(input.path, input.content, input.encoding),
        );
    }

    async requestHelp(agentId, taskId, reason) {
        const control = {
            mode: "requested",
            reason: String(reason ?? "help requested"),
            taskId,
            requestedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await this.#registry.setControl(agentId, control);
        await this.#audit.append({
            type: "computer.help_requested",
            actor: agentId,
            subject: `computer:${agentId}`,
            data: { taskId, reason: control.reason },
        });
        return control;
    }

    async takeControl(agentId, actorId) {
        if (!actorId)
            throw new Error("human actor id is required to take control");
        const previous = await this.#registry.control(agentId);
        const control = {
            mode: "human",
            actorId,
            reason: previous.reason,
            takenAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await this.#registry.setControl(agentId, control);
        await this.#audit.append({
            type: "computer.control_taken",
            actor: actorId,
            subject: `computer:${agentId}`,
            data: { agentId, reason: previous.reason },
        });
        return control;
    }

    async releaseControl(agentId, actorId) {
        if (!actorId)
            throw new Error("human actor id is required to release control");
        const previous = await this.#registry.control(agentId);
        const control = {
            mode: "agent",
            releasedBy: actorId,
            releasedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await this.#registry.setControl(agentId, control);
        await this.#audit.append({
            type: "computer.control_released",
            actor: actorId,
            subject: `computer:${agentId}`,
            data: { agentId, previousMode: previous.mode },
        });
        return control;
    }

    async requestSecret(agentId, taskId, input) {
        const resolved = this.#resolveElement(agentId, input);
        const secretRequest = await this.#govern(
            agentId,
            taskId,
            {
                operation: "request_secret",
                intent: "request_secret",
                target: input.ref,
                page: resolved.page,
                element: resolved.element ? publicElement(resolved.element) : undefined,
                hardDeny: resolved.reason,
            },
            async () => ({
                id: createId("secret_request"),
                taskId,
                label: String(input.label ?? "secret"),
                snapshotId: input.snapshotId,
                ref: input.ref,
                requestedAt: new Date().toISOString(),
            }),
        );
        await this.#registry.setSecretRequest(agentId, secretRequest);
        await this.#registry.setControl(agentId, {
            mode: "requested",
            requestId: secretRequest.id,
            reason: `secret requested: ${secretRequest.label}`,
            taskId,
            requestedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        await this.#audit.append({
            type: "computer.secret_requested",
            actor: agentId,
            subject: `computer:${agentId}`,
            data: { taskId, label: secretRequest.label, ref: secretRequest.ref },
        });
        return secretRequest;
    }

    async supplySecret(agentId, actorId, requestId, text) {
        if (!actorId)
            throw new Error("human actor id is required to supply a secret");
        const request = await this.#registry.secretRequest(agentId);
        if (!request || request.id !== requestId)
            throw new Error("secret request is missing, expired, or does not match");
        const resolved = this.#resolveElement(agentId, request);
        if (resolved.reason)
            throw new Error(`secret request is no longer safe to fulfill: ${resolved.reason}`);

        const characters = [...String(text)].length;
        await this.#audit.append({
            type: "computer.secret_supplied",
            actor: actorId,
            subject: `computer:${agentId}`,
            data: { requestId, label: request.label, ref: request.ref, characters },
        });
        try {
            const result = await (await this.#driver(agentId)).typeSecret({
                element: resolved.element,
                text: String(text),
            });
            await this.#registry.clearSecretRequest(agentId);
            const control = await this.#registry.control(agentId);
            if (control.mode === "requested" && control.requestId === requestId) {
                await this.#registry.setControl(agentId, {
                    mode: "agent",
                    releasedBy: actorId,
                    releasedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
            }
            await this.#audit.append({
                type: "computer.secret_supply_succeeded",
                actor: actorId,
                subject: `computer:${agentId}`,
                data: { requestId, characters },
            });
            return { ...result, characters };
        }
        catch (error) {
            await this.#audit.append({
                type: "computer.secret_supply_failed",
                actor: actorId,
                subject: `computer:${agentId}`,
                data: { requestId, characters, error: error.message },
            });
            throw error;
        }
    }

    async #govern(agentId, taskId, descriptor, run) {
        const control = await this.#registry.control(agentId);
        const controlDeny = control.mode === "agent"
            ? undefined
            : control.mode === "human"
                ? `human control is active for this computer (${control.actorId ?? "operator"})`
                : "computer is paused because human help was requested";
        const action = {
            category: "computer",
            operation: descriptor.operation,
            intent: descriptor.intent,
            target: descriptor.target,
            repeatKey: descriptor.repeatKey,
            agentId,
            taskId,
            page: descriptor.page,
            element: descriptor.element,
            file: descriptor.file,
            key: descriptor.key,
            hardDeny: descriptor.hardDeny ?? controlDeny,
        };
        const decision = await this.#governor.authorize(action);
        if (!decision.allowed)
            throw new ComputerActionRefusedError(decision.reason, decision);

        try {
            const result = await run();
            await this.#audit.append({
                type: "computer.action_succeeded",
                actor: agentId,
                subject: safeAuditSubject(descriptor.target),
                data: {
                    taskId,
                    operation: descriptor.operation,
                    intent: descriptor.intent,
                    ruleId: decision.ruleId,
                },
            });
            return result;
        }
        catch (error) {
            await this.#audit.append({
                type: "computer.action_failed",
                actor: agentId,
                subject: safeAuditSubject(descriptor.target),
                data: {
                    taskId,
                    operation: descriptor.operation,
                    intent: descriptor.intent,
                    ruleId: decision.ruleId,
                    error: error.message,
                },
            });
            throw error;
        }
    }

    async #driver(agentId) {
        let driver = this.#drivers.get(agentId);
        if (driver)
            return driver;
        const record = await this.#registry.ensure(agentId);
        driver = this.#driverFactory?.forComputer
            ? await this.#driverFactory.forComputer(record)
            : this.#driverFactory
                ? await this.#driverFactory(record)
                : new UnavailableComputerDriver();
        if (!driver)
            driver = new UnavailableComputerDriver();
        this.#drivers.set(agentId, driver);
        return driver;
    }

    async #workspace(agentId) {
        let workspace = this.#workspaces.get(agentId);
        if (workspace)
            return workspace;
        const record = await this.#registry.ensure(agentId);
        workspace = new ComputerWorkspace(record.workspaceDir);
        await workspace.init();
        this.#workspaces.set(agentId, workspace);
        return workspace;
    }

    async #workspacePolicySubject(agentId, path) {
        const record = await this.#registry.ensure(agentId);
        try {
            resolveWorkspacePath(record.workspaceDir, path);
            return { file: workspaceSubject(path) };
        }
        catch (error) {
            return { file: workspaceSubject(path), reason: error.message };
        }
    }

    #currentPage(agentId) {
        const snapshot = this.#snapshots.get(agentId);
        if (!snapshot)
            return { reason: "a fresh snapshot is required before this action" };
        return { page: pageOf(snapshot.url) };
    }

    #resolveElement(agentId, input) {
        const snapshot = this.#snapshots.get(agentId);
        if (!snapshot)
            return { reason: "a fresh snapshot is required before acting on an element" };
        if (!input.snapshotId || input.snapshotId !== snapshot.id) {
            return {
                page: pageOf(snapshot.url),
                reason: "snapshot id is missing or stale; take a fresh snapshot before acting",
            };
        }
        const element = snapshot.elements.get(input.ref);
        if (!element) {
            return {
                page: pageOf(snapshot.url),
                reason: `element ref is not present in the server-held snapshot: ${input.ref}`,
            };
        }
        return { page: pageOf(snapshot.url), element };
    }
}
