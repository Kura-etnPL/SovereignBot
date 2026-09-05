import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { internalNodeExecutable } from "./internal-node.js";

const SIDECAR_PROTOCOL = "sovereignbot.sidecar.v1";
const BUNDLED_WEBDRIVER_SIDECAR = fileURLToPath(new URL("../sidecars/webdriver/server.js", import.meta.url));

const SIDECAR_ENV_KEYS = [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SNAP", "SNAP_NAME", "SNAP_INSTANCE_NAME",
    "CHROMEWEBDRIVER", "GECKOWEBDRIVER", "EDGEWEBDRIVER",
];

function sidecarBaseEnv(source = process.env) {
    const env = {};
    for (const key of SIDECAR_ENV_KEYS) {
        const value = source[key];
        if (value !== undefined)
            env[key] = value;
    }
    return env;
}

function capped(text, addition, max = 12_000) {
    return `${text}${addition}`.slice(-max);
}

export class SidecarComputerDriver {
    #record;
    #config;
    #child;
    #endpoint;
    #transportToken;
    #processLease;
    #sessionLease;
    #starting;
    #stderr = "";
    #closed = false;

    constructor(record, config = {}) {
        this.#record = record;
        this.#config = config;
    }

    async health() {
        await this.#ensureStarted();
        const result = await this.#request("GET", "/health");
        if (result.processLease !== this.#processLease)
            throw new Error("computer sidecar process lease changed unexpectedly");
        this.#sessionLease = result.sessionLease ?? this.#sessionLease;
        return result;
    }

    async frame() {
        if (!this.#child || !this.#endpoint || this.#child.exitCode !== null)
            throw new Error("computer browser is not running");
        const result = await this.#requestRaw("GET", "/frame", undefined, { timeoutMs: 15_000 });
        if (result.leaseId)
            this.#sessionLease = result.leaseId;
        if (result.mimeType !== "image/png" || typeof result.data !== "string")
            throw new Error("computer sidecar returned an invalid live frame");
        return {
            mimeType: "image/png",
            data: result.data,
            url: result.url,
            capturedAt: result.capturedAt,
        };
    }

    async snapshot() {
        const result = await this.#request("POST", "/snapshot", {});
        if (!result.leaseId)
            throw new Error("computer sidecar snapshot omitted its browser lease");
        this.#sessionLease = result.leaseId;
        return {
            url: result.url,
            title: result.title,
            elements: (result.elements ?? []).map((element) => ({
                ref: element.ref,
                role: element.role,
                name: element.name,
                type: element.type,
                disabled: element.disabled,
                sidecarHandle: element.handle,
                sidecarLease: result.leaseId,
            })),
        };
    }

    async text() {
        const result = await this.#request("POST", "/text", {});
        if (result.leaseId)
            this.#sessionLease = result.leaseId;
        return { text: String(result.text ?? "") };
    }

    async navigate(url) {
        const result = await this.#request("POST", "/navigate", { url });
        if (result.leaseId)
            this.#sessionLease = result.leaseId;
        return { url: result.url };
    }

    async chatGPTPage() {
        const result = await this.#request("POST", "/chatgpt-page", {});
        if (result.leaseId) this.#sessionLease = result.leaseId;
        return result.page;
    }

    async click({ element }) {
        await this.#ensureElementLease(element);
        return this.#request("POST", "/click", {
            leaseId: this.#sessionLease,
            handle: element.sidecarHandle,
        });
    }

    async type({ element, text }) {
        await this.#ensureElementLease(element);
        return this.#request("POST", "/type", {
            leaseId: this.#sessionLease,
            handle: element.sidecarHandle,
            text,
        });
    }

    async typeSecret({ element, text }) {
        await this.#ensureElementLease(element);
        return this.#request("POST", "/type-secret", {
            leaseId: this.#sessionLease,
            handle: element.sidecarHandle,
            text,
        }, { secret: true });
    }

    async key({ element, key }) {
        await this.#ensureStarted();
        if (element)
            await this.#ensureElementLease(element);
        else if (!this.#sessionLease)
            throw new Error("computer sidecar key input requires a fresh snapshot/browser lease");
        return this.#request("POST", "/key", {
            leaseId: this.#sessionLease,
            handle: element?.sidecarHandle,
            key,
        });
    }

    async scroll(input = {}) {
        await this.#ensureStarted();
        if (!this.#sessionLease)
            throw new Error("computer sidecar scroll requires a fresh snapshot/browser lease");
        return this.#request("POST", "/scroll", {
            leaseId: this.#sessionLease,
            deltaX: input.deltaX ?? 0,
            deltaY: input.deltaY ?? 0,
        });
    }

    async stop() {
        if (!this.#endpoint)
            return { stopped: true, wasRunning: false };
        const result = await this.#request("POST", "/stop", {});
        this.#sessionLease = undefined;
        return { ...result, wasRunning: true };
    }

    async reset() {
        const result = await this.#request("POST", "/reset", {});
        this.#sessionLease = result.leaseId;
        return result;
    }

    async close() {
        this.#closed = true;
        await this.#starting?.catch(() => undefined);
        const child = this.#child;
        if (!child)
            return;
        try {
            if (this.#endpoint)
                await this.#requestRaw("POST", "/shutdown", {}, { timeoutMs: (this.#config.requestTimeoutMs ?? 30_000) + 5000 });
        }
        catch {
        }
        await this.#terminate(child);
        this.#clearProcess(child);
    }

    async #ensureElementLease(element) {
        await this.#ensureStarted();
        if (!element?.sidecarHandle || !element?.sidecarLease)
            throw new Error("computer element is missing its private sidecar handle");
        if (!this.#sessionLease || element.sidecarLease !== this.#sessionLease)
            throw new Error("computer sidecar browser lease changed; take a fresh snapshot");
    }

    async #ensureStarted() {
        if (this.#closed)
            throw new Error("computer sidecar driver is closed");
        if (this.#child && this.#endpoint && this.#child.exitCode === null)
            return;
        if (!this.#starting)
            this.#starting = this.#startProcess().finally(() => { this.#starting = undefined; });
        return this.#starting;
    }

    async #startProcess() {
        const transportToken = randomBytes(32).toString("base64url");
        const command = this.#config.sidecarCommand ?? internalNodeExecutable();
        const args = this.#config.sidecarArgs?.length
            ? this.#config.sidecarArgs
            : [BUNDLED_WEBDRIVER_SIDECAR];
        const sidecarConfig = {
            browser: this.#config.browser ?? "chrome",
            headless: Boolean(this.#config.headless),
            browserBinary: this.#config.browserBinary,
            webdriverUrl: this.#config.webdriverUrl,
            webdriverCommand: this.#config.webdriverCommand,
            webdriverArgs: this.#config.webdriverArgs,
            startupTimeoutMs: this.#config.startupTimeoutMs ?? 20_000,
            requestTimeoutMs: this.#config.requestTimeoutMs ?? 30_000,
            allowPrivateHosts: Boolean(this.#config.allowPrivateHosts),
        };
        const child = spawn(command, args, {
            shell: false,
            cwd: this.#config.cwd,
            windowsHide: true,
            env: {
                ...sidecarBaseEnv(),
                ...this.#config.env,
                SOVEREIGNBOT_PROFILE_DIR: this.#record.profileDir,
                SOVEREIGNBOT_WORKSPACE_DIR: this.#record.workspaceDir,
                SOVEREIGNBOT_SIDECAR_CONFIG_JSON: JSON.stringify(sidecarConfig),
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ protocol: SIDECAR_PROTOCOL, token: transportToken }));

        this.#stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { this.#stderr = capped(this.#stderr, chunk); });

        const startupTimeoutMs = this.#config.startupTimeoutMs ?? 20_000;
        const ready = await new Promise((resolve, reject) => {
            let settled = false;
            const failWithContext = (prefix) => {
                const detail = this.#stderr.trim().slice(-2400);
                return new Error(detail ? `${prefix}: ${detail}` : prefix);
            };
            const timeout = setTimeout(() => {
                if (!settled)
                    reject(failWithContext(`computer sidecar did not become ready within ${startupTimeoutMs}ms`));
            }, startupTimeoutMs);
            const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
            const finish = (fn, value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                lines.close();
                fn(value);
            };
            child.once("error", (error) => finish(reject, error));
            child.once("exit", (code, signal) => {
                finish(reject, failWithContext(`computer sidecar exited before ready (${code ?? signal})`));
            });
            (async () => {
                try {
                    for await (const line of lines) {
                        if (!line.trim())
                            continue;
                        let parsed;
                        try {
                            parsed = JSON.parse(line);
                        }
                        catch {
                            throw new Error("computer sidecar first stdout line was not protocol JSON");
                        }
                        finish(resolve, parsed);
                        return;
                    }
                }
                catch (error) {
                    finish(reject, error);
                }
            })();
        }).catch(async (error) => {
            await this.#terminate(child);
            throw error;
        });

        if (ready.protocol !== SIDECAR_PROTOCOL || ready.host !== "127.0.0.1" || !Number.isInteger(ready.port)) {
            await this.#terminate(child);
            throw new Error("computer sidecar returned an invalid ready handshake");
        }
        this.#child = child;
        this.#transportToken = transportToken;
        this.#endpoint = `http://127.0.0.1:${ready.port}`;
        this.#processLease = ready.processLease;
        this.#sessionLease = ready.sessionLease;

        child.once("exit", () => this.#clearProcess(child));
        const health = await this.#requestRaw("GET", "/health", undefined, { timeoutMs: 5000 });
        if (!health.ok || health.processLease !== this.#processLease) {
            await this.#terminate(child);
            this.#clearProcess(child);
            throw new Error("computer sidecar failed its authenticated health handshake");
        }
    }

    async #request(method, path, body, options = {}) {
        await this.#ensureStarted();
        try {
            return await this.#requestRaw(method, path, body, options);
        }
        catch (error) {
            if (error.cause?.code === "ECONNREFUSED" || error.name === "TypeError") {
                const child = this.#child;
                this.#clearProcess(child);
            }
            throw error;
        }
    }

    async #requestRaw(method, path, body, { secret = false, timeoutMs } = {}) {
        if (!this.#endpoint || !this.#transportToken)
            throw new Error("computer sidecar transport is not ready");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.#config.requestTimeoutMs ?? 30_000);
        try {
            const response = await fetch(`${this.#endpoint}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.#transportToken}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
            const text = await response.text();
            let payload = {};
            try {
                payload = text ? JSON.parse(text) : {};
            }
            catch {
                throw new Error(`computer sidecar returned non-JSON status ${response.status}`);
            }
            if (!response.ok) {
                if (secret)
                    throw new Error(`computer sidecar secret input failed with status ${response.status}`);
                throw new Error(String(payload.error ?? `computer sidecar returned ${response.status}`).slice(0, 1400));
            }
            return payload;
        }
        finally {
            clearTimeout(timeout);
        }
    }

    #clearProcess(child) {
        if (child && this.#child && child !== this.#child)
            return;
        this.#child = undefined;
        this.#endpoint = undefined;
        this.#transportToken = undefined;
        this.#processLease = undefined;
        this.#sessionLease = undefined;
    }

    async #terminate(child) {
        if (!child || child.exitCode !== null)
            return;
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                try { child.kill("SIGKILL"); } catch {}
                resolve();
            }, 2500);
            child.once("exit", () => {
                clearTimeout(timeout);
                resolve();
            });
            try { child.kill("SIGTERM"); }
            catch {
                clearTimeout(timeout);
                resolve();
            }
        });
    }
}

export function createWebDriverSidecarFactory(config = {}) {
    const drivers = new Map();
    return {
        forComputer(record) {
            let driver = drivers.get(record.agentId);
            if (!driver) {
                driver = new SidecarComputerDriver(record, config);
                drivers.set(record.agentId, driver);
            }
            return driver;
        },
        get(agentId) {
            return drivers.get(agentId);
        },
        async close() {
            await Promise.allSettled([...drivers.values()].map((driver) => driver.close()));
        },
    };
}
