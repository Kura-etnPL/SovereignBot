import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createId } from "./id.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { validatePolicyDraft } from "./policy-dry-run.js";

const SCHEMA_VERSION = 1;
const VERSION_ID = /^policy_[0-9a-f-]{36}$/;

function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function policyHash(policy) {
    const validated = validatePolicyDraft(policy);
    return createHash("sha256").update(canonical(validated)).digest("hex");
}

function safeVersionId(id) {
    if (typeof id !== "string" || !VERSION_ID.test(id))
        throw new Error("policy version id is invalid");
    return id;
}

function validateVersion(value) {
    if (!value || value.schemaVersion !== SCHEMA_VERSION)
        throw new Error("policy version is invalid or unsupported");
    safeVersionId(value.id);
    if (!/^[0-9a-f]{64}$/.test(value.hash ?? ""))
        throw new Error(`policy version ${value.id} has an invalid hash`);
    if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))
        throw new Error(`policy version ${value.id} has an invalid createdAt`);
    if (value.parentVersionId !== undefined && value.parentVersionId !== null)
        safeVersionId(value.parentVersionId);
    if (value.label !== undefined && typeof value.label !== "string")
        throw new Error(`policy version ${value.id} has an invalid label`);
    const policy = validatePolicyDraft(value.policy);
    const actual = policyHash(policy);
    if (actual !== value.hash)
        throw new Error(`policy version ${value.id} hash mismatch`);
    return { ...value, policy };
}

function validatePointer(value) {
    if (!value || value.schemaVersion !== SCHEMA_VERSION)
        throw new Error("active policy pointer is invalid or unsupported");
    safeVersionId(value.versionId);
    if (!/^[0-9a-f]{64}$/.test(value.hash ?? ""))
        throw new Error("active policy pointer hash is invalid");
    if (typeof value.activatedAt !== "string" || Number.isNaN(Date.parse(value.activatedAt)))
        throw new Error("active policy pointer activatedAt is invalid");
    return value;
}

function validateTransaction(value) {
    if (!value || value.schemaVersion !== SCHEMA_VERSION || !["bootstrap", "activation"].includes(value.kind))
        throw new Error("policy transaction marker is invalid or unsupported");
    if (typeof value.transactionId !== "string" || !value.transactionId.startsWith("policytx_"))
        throw new Error("policy transaction marker id is invalid");
    safeVersionId(value.toVersionId);
    if (value.fromVersionId !== undefined && value.fromVersionId !== null)
        safeVersionId(value.fromVersionId);
    if (!/^[0-9a-f]{64}$/.test(value.toHash ?? ""))
        throw new Error("policy transaction marker hash is invalid");
    return value;
}

export class PolicyVersionStore {
    #root;
    #versionsDir;
    #activePath;
    #transactionPath;
    #active;
    #queue = Promise.resolve();
    #io;

    constructor(dataDir, io = {}) {
        this.#root = join(dataDir, "policy-versions");
        this.#versionsDir = join(this.#root, "versions");
        this.#activePath = join(this.#root, "active.json");
        this.#transactionPath = join(this.#root, "transaction.json");
        this.#io = {
            writeJson: io.writeJson ?? writeJsonAtomic,
            readJson: io.readJson ?? readJsonFile,
            writeFile: io.writeFile ?? writeFile,
            readFile: io.readFile ?? readFile,
            readdir: io.readdir ?? readdir,
            unlink: io.unlink ?? unlink,
        };
    }

    async init(configPolicy, { audit } = {}) {
        const validatedConfig = validatePolicyDraft(configPolicy);
        await mkdir(this.#versionsDir, { recursive: true });

        const markerRaw = await this.#io.readJson(this.#transactionPath, undefined);
        if (markerRaw) {
            const marker = validateTransaction(markerRaw);
            if (marker.kind === "bootstrap")
                await this.#recoverBootstrap(marker, validatedConfig);
            else
                await this.#recoverCommittedActivationOrFail(marker, audit);
        }

        const pointerRaw = await this.#io.readJson(this.#activePath, undefined);
        if (!pointerRaw) {
            const files = (await this.#io.readdir(this.#versionsDir)).filter((name) => name.endsWith(".json"));
            if (files.length)
                throw new Error("policy version state exists but active.json is missing; refusing config-policy fallback");
            const bootstrapped = await this.#bootstrap(validatedConfig);
            this.#active = bootstrapped;
            return { version: structuredClone(bootstrapped), bootstrapped: true };
        }

        const pointer = validatePointer(pointerRaw);
        const version = await this.readVersion(pointer.versionId);
        if (version.hash !== pointer.hash)
            throw new Error("active policy pointer/version hash mismatch");
        this.#active = version;
        return { version: structuredClone(version), bootstrapped: false };
    }

    async #createTransaction(transaction) {
        validateTransaction(transaction);
        try {
            await this.#io.writeFile(
                this.#transactionPath,
                `${JSON.stringify(transaction, null, 2)}\n`,
                { encoding: "utf8", flag: "wx" },
            );
        }
        catch (error) {
            if (error.code === "EEXIST")
                throw new Error("another policy transaction or recovery marker already exists");
            throw error;
        }
        return structuredClone(transaction);
    }

    async #bootstrap(policy) {
        const version = this.#buildVersion(policy, {
            id: createId("policy"),
            source: "bootstrap",
            label: "initial config policy",
        });
        const transaction = {
            schemaVersion: SCHEMA_VERSION,
            kind: "bootstrap",
            transactionId: createId("policytx"),
            toVersionId: version.id,
            toHash: version.hash,
            startedAt: new Date().toISOString(),
        };
        await this.#createTransaction(transaction);
        try {
            await this.#writeVersion(version);
            await this.#writePointer(version);
            await this.clearTransaction();
            return version;
        }
        catch (error) {
            // Keep the marker: later startup may complete only this recognized bootstrap.
            throw error;
        }
    }

    async #recoverBootstrap(marker, configPolicy) {
        if (policyHash(configPolicy) !== marker.toHash)
            throw new Error("incomplete policy bootstrap does not match current config; refusing automatic recovery");
        let version;
        try {
            version = await this.readVersion(marker.toVersionId);
        }
        catch (error) {
            if (!/not found/.test(error.message))
                throw error;
            version = this.#buildVersion(configPolicy, {
                id: marker.toVersionId,
                source: "bootstrap-recovery",
                label: "recovered initial config policy",
            });
            if (version.hash !== marker.toHash)
                throw new Error("policy bootstrap recovery hash mismatch");
            await this.#writeVersion(version);
        }
        if (version.hash !== marker.toHash)
            throw new Error("policy bootstrap recovery version hash mismatch");
        await this.#writePointer(version);
        await this.clearTransaction();
    }

    async #recoverCommittedActivationOrFail(marker, audit) {
        if (!audit)
            throw new Error(`incomplete policy activation ${marker.transactionId}; audit reconciliation is unavailable`);
        const integrity = await audit.verify();
        if (!integrity.ok)
            throw new Error(`cannot reconcile policy activation ${marker.transactionId}: audit integrity failed at sequence ${integrity.seq ?? "unknown"}`);
        const records = await audit.readAll();
        const committed = records.some((record) =>
            ["policy.activated", "policy.rolled_back"].includes(record.type)
            && record.subject === marker.toVersionId
            && record.data?.transactionId === marker.transactionId,
        );
        if (!committed)
            throw new Error(`incomplete policy activation ${marker.transactionId}; refusing startup until recovered`);
        const pointerRaw = await this.#io.readJson(this.#activePath, undefined);
        if (!pointerRaw)
            throw new Error(`committed policy activation ${marker.transactionId} has no active pointer`);
        const pointer = validatePointer(pointerRaw);
        if (pointer.versionId !== marker.toVersionId || pointer.hash !== marker.toHash)
            throw new Error(`committed policy activation ${marker.transactionId} does not match active pointer`);
        const version = await this.readVersion(pointer.versionId);
        if (version.hash !== marker.toHash)
            throw new Error(`committed policy activation ${marker.transactionId} version hash mismatch`);
        await this.clearTransaction();
    }

    #buildVersion(policy, { id = createId("policy"), source = "apply", label, parentVersionId } = {}) {
        safeVersionId(id);
        const validated = validatePolicyDraft(policy);
        return {
            schemaVersion: SCHEMA_VERSION,
            id,
            hash: policyHash(validated),
            createdAt: new Date().toISOString(),
            source,
            label: label ? String(label).slice(0, 160) : undefined,
            parentVersionId,
            policy: validated,
        };
    }

    async #writeVersion(version) {
        const path = join(this.#versionsDir, `${safeVersionId(version.id)}.json`);
        try {
            await this.#io.writeFile(path, `${JSON.stringify(version, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const existing = validateVersion(JSON.parse(await this.#io.readFile(path, "utf8")));
            if (existing.hash !== version.hash)
                throw new Error(`policy version id collision: ${version.id}`);
        }
    }

    async #writePointer(version) {
        await this.#io.writeJson(this.#activePath, {
            schemaVersion: SCHEMA_VERSION,
            versionId: version.id,
            hash: version.hash,
            activatedAt: new Date().toISOString(),
        });
        this.#active = version;
    }

    async createVersion(policy, metadata = {}) {
        const operation = this.#queue.then(async () => {
            const version = this.#buildVersion(policy, metadata);
            await this.#writeVersion(version);
            return structuredClone(version);
        });
        this.#queue = operation.catch(() => undefined);
        return operation;
    }

    async beginActivation({ fromVersionId, toVersionId, toHash, kind = "activation" }) {
        const transaction = {
            schemaVersion: SCHEMA_VERSION,
            kind,
            transactionId: createId("policytx"),
            fromVersionId,
            toVersionId: safeVersionId(toVersionId),
            toHash,
            startedAt: new Date().toISOString(),
        };
        return this.#createTransaction(transaction);
    }

    async setActive(version) {
        const validated = validateVersion(version);
        await this.#writePointer(validated);
        return structuredClone(validated);
    }

    async clearTransaction() {
        await this.#io.unlink(this.#transactionPath).catch((error) => {
            if (error.code !== "ENOENT")
                throw error;
        });
    }

    current() {
        if (!this.#active)
            throw new Error("policy version store is not initialized");
        return structuredClone(this.#active);
    }

    async readVersion(id) {
        const safeId = safeVersionId(id);
        try {
            return validateVersion(JSON.parse(await this.#io.readFile(join(this.#versionsDir, `${safeId}.json`), "utf8")));
        }
        catch (error) {
            if (error.code === "ENOENT")
                throw new Error(`policy version not found: ${safeId}`);
            throw error;
        }
    }

    async listVersions() {
        const files = (await this.#io.readdir(this.#versionsDir)).filter((name) => name.endsWith(".json"));
        const versions = [];
        for (const file of files) {
            const id = file.slice(0, -5);
            safeVersionId(id);
            versions.push(await this.readVersion(id));
        }
        return versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((version) => structuredClone(version));
    }
}
