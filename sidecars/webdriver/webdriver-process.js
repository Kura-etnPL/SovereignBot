import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import net from "node:net";

async function executableFile(path) {
    if (!path)
        return false;
    try {
        const info = await stat(path);
        if (!info.isFile())
            return false;
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}

async function directory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}

async function findOnPath(names) {
    const entries = String(process.env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const entry of entries) {
        for (const name of names) {
            const candidate = join(entry.replace(/^"|"$/g, ""), name);
            if (await executableFile(candidate))
                return candidate;
        }
    }
    return undefined;
}

async function executableFromEnvironment(browser) {
    const file = process.platform === "win32" ? ".exe" : "";
    const specs = browser === "firefox"
        ? { env: "GECKOWEBDRIVER", names: [`geckodriver${file}`] }
        : browser === "edge"
            ? { env: "EDGEWEBDRIVER", names: [`msedgedriver${file}`] }
            : { env: "CHROMEWEBDRIVER", names: [`chromedriver${file}`] };

    const hinted = process.env[specs.env];
    if (hinted) {
        if (await executableFile(hinted))
            return hinted;
        if (await directory(hinted)) {
            for (const name of specs.names) {
                const nested = join(hinted, name);
                if (await executableFile(nested))
                    return nested;
            }
        }
    }
    return findOnPath(specs.names);
}

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("could not reserve a WebDriver port");
    const port = address.port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

function defaultArgs(browser, port) {
    if (browser === "firefox")
        return ["--host", "127.0.0.1", "--port", String(port)];
    return [`--port=${port}`];
}

function validatedLoopbackEndpoint(value) {
    let parsed;
    try {
        parsed = new URL(String(value));
    }
    catch {
        throw new Error("configured WebDriver endpoint is not a valid URL");
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host))
        throw new Error("configured WebDriver endpoint must be a loopback http endpoint");
    if (parsed.username || parsed.password)
        throw new Error("configured WebDriver endpoint must not contain credentials");
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
}

async function waitUntilReady(endpoint, child, timeoutMs, stderr, spawnError) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        const startupError = spawnError();
        if (startupError)
            throw new Error(`WebDriver failed to start: ${startupError.message}`);
        if (child?.exitCode !== null && child?.exitCode !== undefined)
            throw new Error(`WebDriver exited before ready (${child.exitCode}): ${stderr().slice(-1600)}`);
        try {
            const response = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(1000) });
            if (response.ok)
                return;
        }
        catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`WebDriver did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

export async function startWebDriverProcess({
    browser = "chrome",
    endpoint,
    command,
    args,
    startupTimeoutMs = 15_000,
} = {}) {
    if (endpoint) {
        const normalized = validatedLoopbackEndpoint(endpoint);
        const response = await fetch(`${normalized}/status`, { signal: AbortSignal.timeout(startupTimeoutMs) });
        if (!response.ok)
            throw new Error(`configured WebDriver endpoint returned ${response.status}`);
        return { endpoint: normalized, external: true, close: async () => {} };
    }

    const executable = command || await executableFromEnvironment(browser);
    if (!executable) {
        const expected = browser === "firefox" ? "geckodriver" : browser === "edge" ? "msedgedriver" : "chromedriver";
        throw new Error(`no ${expected} executable was found; configure computer.driver.webdriverCommand or install the browser driver`);
    }

    const port = await reservePort();
    const finalArgs = Array.isArray(args) && args.length
        ? args.map((value) => String(value).replaceAll("{port}", String(port)))
        : defaultArgs(browser, port);
    const child = spawn(executable, finalArgs, {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
    });
    let stderrText = "";
    let startError;
    child.once("error", (error) => { startError = error; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
        stderrText = `${stderrText}${chunk}`.slice(-12_000);
    });
    const endpointUrl = `http://127.0.0.1:${port}`;
    try {
        await waitUntilReady(endpointUrl, child, startupTimeoutMs, () => stderrText, () => startError);
    }
    catch (error) {
        try {
            child.kill();
        }
        catch {
        }
        throw error;
    }

    return {
        endpoint: endpointUrl,
        external: false,
        pid: child.pid,
        close: async () => {
            if (child.exitCode !== null)
                return;
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch {
                    }
                    resolve();
                }, 2000);
                child.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    clearTimeout(timer);
                    resolve();
                }
            });
        },
    };
}
