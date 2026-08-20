import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

function safeSegment(agentId) {
    return encodeURIComponent(agentId).replace(/%/g, "_");
}

function tokenMatches(expected, provided) {
    const a = Buffer.from(expected ?? "");
    const b = Buffer.from(provided ?? "");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export class ComputerRegistry {
    #root;
    #statePath;
    #agentIds;
    #stateQueue = Promise.resolve();

    constructor(dataDir, agentIds) {
        this.#root = resolve(dataDir, "computers");
        this.#statePath = join(this.#root, "state.json");
        this.#agentIds = new Set(agentIds);
    }

    async init() {
        await mkdir(this.#root, { recursive: true });
        for (const agentId of this.#agentIds)
            await this.ensure(agentId);
    }

    async ensure(agentId) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const dir = join(this.#root, safeSegment(agentId));
        const profileDir = join(dir, "profile");
        const workspaceDir = join(dir, "workspace");
        await mkdir(profileDir, { recursive: true });
        await mkdir(workspaceDir, { recursive: true });

        const tokenPath = join(dir, "token");
        let token;
        try {
            token = (await readFile(tokenPath, "utf8")).trim();
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            token = randomBytes(32).toString("base64url");
            await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
        if (!token)
            throw new Error(`computer token is empty for agent ${agentId}`);

        const state = await this.#readState(agentId);
        return {
            id: `computer:${agentId}`,
            agentId,
            rootDir: dir,
            profileDir,
            workspaceDir,
            token,
            control: state.control,
            secretRequest: state.secretRequest,
        };
    }

    async list() {
        const records = [];
        for (const agentId of this.#agentIds) {
            const record = await this.ensure(agentId);
            records.push({
                id: record.id,
                agentId,
                profileDir: record.profileDir,
                workspaceDir: record.workspaceDir,
                control: record.control,
                hasPendingSecret: Boolean(record.secretRequest),
            });
        }
        return records;
    }

    async authenticate(agentId, token) {
        const record = await this.ensure(agentId);
        return tokenMatches(record.token, token);
    }

    async credentials(agentId) {
        const record = await this.ensure(agentId);
        return { agentId, token: record.token };
    }

    async control(agentId) {
        return (await this.#readState(agentId)).control;
    }

    async setControl(agentId, control) {
        return this.#mutateState(agentId, (state) => ({ ...state, control }));
    }

    async secretRequest(agentId) {
        return (await this.#readState(agentId)).secretRequest;
    }

    async setSecretRequest(agentId, secretRequest) {
        return this.#mutateState(agentId, (state) => ({ ...state, secretRequest }));
    }

    async clearSecretRequest(agentId) {
        return this.#mutateState(agentId, (state) => ({ ...state, secretRequest: undefined }));
    }

    async #readState(agentId) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const all = await readJsonFile(this.#statePath, {});
        return all[agentId] ?? {
            control: {
                mode: "agent",
                updatedAt: new Date(0).toISOString(),
            },
        };
    }

    async #mutateState(agentId, mutator) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const operation = this.#stateQueue.then(async () => {
            const all = await readJsonFile(this.#statePath, {});
            const current = all[agentId] ?? {
                control: { mode: "agent", updatedAt: new Date(0).toISOString() },
            };
            const next = await mutator(structuredClone(current));
            all[agentId] = next;
            await writeJsonAtomic(this.#statePath, all);
            return structuredClone(next);
        });
        this.#stateQueue = operation.catch(() => undefined);
        return operation;
    }
}
