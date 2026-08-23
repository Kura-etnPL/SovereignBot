import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    computerIdentityKey,
    computerV2StateDocument,
    migrateComputerRegistry,
} from "./computer-migration.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";

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

function defaultState() {
    return {
        control: {
            mode: "agent",
            updatedAt: new Date(0).toISOString(),
        },
    };
}

export class ComputerRegistry {
    #root;
    #statePath;
    #agentIds;
    #stateQueue = Promise.resolve();
    #operatorToken;
    #migrationIo;

    constructor(dataDir, agentIds, { migrationIo } = {}) {
        this.#root = resolve(dataDir, "computers");
        this.#statePath = join(this.#root, "state.json");
        this.#agentIds = new Set(agentIds);
        this.#migrationIo = migrationIo;
    }

    async init() {
        await mkdir(this.#root, { recursive: true });
        await migrateComputerRegistry(this.#root, this.#agentIds, this.#migrationIo);
        const current = await readJsonFile(this.#statePath, undefined);
        if (current === undefined)
            await writeJsonAtomic(this.#statePath, { version: 2, agents: {} });
        else if (!computerV2StateDocument(current))
            throw new Error("computer state migration did not commit a valid v2 state");

        // Credentials/profile roots are initialized only after migration has committed or recovered.
        this.#operatorToken = await getOrCreateToken(join(this.#root, "operator-token"));
        for (const agentId of this.#agentIds)
            await this.ensure(agentId);
    }

    async ensure(agentId) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const dir = join(this.#root, computerIdentityKey(agentId));
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
        if (!computerV2StateDocument(document))
            throw new Error("computer state requires migration; call ComputerRegistry.init() first");
        return document.agents[computerIdentityKey(agentId)] ?? defaultState();
    }

    async #mutateState(agentId, mutator) {
        if (!this.#agentIds.has(agentId))
            throw new Error(`unknown computer agent: ${agentId}`);
        const key = computerIdentityKey(agentId);
        const operation = this.#stateQueue.then(async () => {
            const document = await readJsonFile(this.#statePath, { version: 2, agents: {} });
            if (!computerV2StateDocument(document))
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
}
