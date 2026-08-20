import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

function identityKey(agentId) {
    return Buffer.from(String(agentId), "utf8").toString("base64url");
}

function legacySegment(agentId) {
    return encodeURIComponent(agentId).replace(/%/g, "_");
}

function tokenMatches(expected, provided) {
    const a = Buffer.from(expected ?? "");
    const b = Buffer.from(provided ?? "");
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function getOrCreateToken(path) {
    try {
        const existing = (await readFile(path, "utf8")).trim();
        if (!existing)
            throw new Error(`token file is empty: ${path}`);
        return existing;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }

    const generated = randomBytes(32).toString("base64url");
    try {
        await writeFile(path, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return generated;
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        const existing = (await readFile(path, "utf8")).trim();
        if (!existing)
            throw new Error(`token file is empty: ${path}`);
        return existing;
    }
}

async function directoryExists(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}

function defaultState() {
    return {
        control: {
            mode: "agent",
            updatedAt: new Date(0).toISOString(),
        },
    };
}

function v2StateDocument(value) {
    return value?.version === 2 && value.agents && typeof value.agents === "object" && !Array.isArray(value.agents);
}

export class ComputerRegistry {
    #root;
    #statePath;
    #agentIds;
    #stateQueue = Promise.resolve();
    #operatorToken;

    constructor(dataDir, agentIds) {
        this.#root = resolve(dataDir, "computers");
        this.#statePath = join(this.#root, "state.json");
        this.#agentIds = new Set(agentIds);
    }

    async init() {
        await mkdir(this.#root, { recursive: true });
        await this.#migrateLegacyState();
        for (const agentId of this.#agentIds)
            await this.#migrateLegacyDirectory(agentId);
        this.#operatorToken = await getOrCreateToken(join(this.#root, "operator-token"));
        for (const agentId of this.#agentIds)
            await this.ensure(agentId);
    }

    async ensure(agentId) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const dir = join(this.#root, identityKey(agentId));
        const profileDir = join(dir, "profile");
        const workspaceDir = join(dir, "workspace");
        await mkdir(profileDir, { recursive: true });
        await mkdir(workspaceDir, { recursive: true });

        const token = await getOrCreateToken(join(dir, "token"));
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

    async authenticateOperator(token) {
        if (!this.#operatorToken)
            this.#operatorToken = await getOrCreateToken(join(this.#root, "operator-token"));
        return tokenMatches(this.#operatorToken, token);
    }

    async credentials(agentId) {
        const record = await this.ensure(agentId);
        return { agentId, token: record.token };
    }

    async operatorCredentials() {
        if (!this.#operatorToken)
            this.#operatorToken = await getOrCreateToken(join(this.#root, "operator-token"));
        return { token: this.#operatorToken };
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
        const document = await readJsonFile(this.#statePath, { version: 2, agents: {} });
        if (!v2StateDocument(document))
            throw new Error("computer state requires migration; call ComputerRegistry.init() first");
        return document.agents[identityKey(agentId)] ?? defaultState();
    }

    async #mutateState(agentId, mutator) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const key = identityKey(agentId);
        const operation = this.#stateQueue.then(async () => {
            const document = await readJsonFile(this.#statePath, { version: 2, agents: {} });
            if (!v2StateDocument(document))
                throw new Error("computer state is not in v2 format");
            const current = document.agents[key] ?? defaultState();
            const next = await mutator(structuredClone(current));
            document.agents[key] = next;
            await writeJsonAtomic(this.#statePath, document);
            return structuredClone(next);
        });
        this.#stateQueue = operation.catch(() => undefined);
        return operation;
    }

    async #migrateLegacyState() {
        const operation = this.#stateQueue.then(async () => {
            const current = await readJsonFile(this.#statePath, undefined);
            if (v2StateDocument(current))
                return;
            const agents = {};
            if (current && typeof current === "object" && !Array.isArray(current)) {
                for (const agentId of this.#agentIds) {
                    if (Object.hasOwn(current, agentId))
                        agents[identityKey(agentId)] = current[agentId];
                }
            }
            await writeJsonAtomic(this.#statePath, { version: 2, agents });
        });
        this.#stateQueue = operation.catch(() => undefined);
        return operation;
    }

    async #migrateLegacyDirectory(agentId) {
        const legacyName = legacySegment(agentId);
        const nextName = identityKey(agentId);
        if (legacyName === nextName)
            return;
        const oldDir = join(this.#root, legacyName);
        const newDir = join(this.#root, nextName);
        if (await directoryExists(newDir) || !await directoryExists(oldDir))
            return;

        const colliders = [...this.#agentIds].filter((candidate) => legacySegment(candidate) === legacyName);
        if (colliders.length > 1) {
            throw new Error(
                `cannot automatically migrate legacy computer directory ${legacyName}: it is ambiguous across agents ${colliders.join(", ")}`,
            );
        }
        await rename(oldDir, newDir);
    }
}
