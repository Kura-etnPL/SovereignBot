import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultConfig, loadConfig, DEFAULT_CONFIG_PATH } from "./src/config.js";
import { createRuntime } from "./src/runtime.js";
import { startServer } from "./src/server.js";

const configPath = resolve(DEFAULT_CONFIG_PATH);
if (!existsSync(configPath)) {
    const config = defaultConfig();
    config.bindHost = "0.0.0.0";
    config.port = 3000;
    await mkdir(resolve(".sovereignbot"), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

const config = await loadConfig(configPath);
config.bindHost = "0.0.0.0";
config.port = 3000;

const runtime = await createRuntime(config);
const server = await startServer(runtime);
console.log(`SovereignBot listening on http://0.0.0.0:3000`);
console.log(`Operator console: http://0.0.0.0:3000/ui/`);

const stop = async () => {
    await server.close();
    await runtime.close();
    process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
