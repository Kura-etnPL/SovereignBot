export class ComputerLifecycleManager {
    #registry;
    #driverFactory;
    #audit;

    constructor({ registry, driverFactory, audit }) {
        this.#registry = registry;
        this.#driverFactory = driverFactory;
        this.#audit = audit;
    }

    async status(agentId) {
        await this.#registry.ensure(agentId);
        if (!this.#driverFactory)
            return { agentId, managed: false, running: false };

        // A status read must never instantiate/start a browser. Bundled managed factories expose
        // `get()` specifically so the operator UI can inspect whether a driver object already exists.
        if (typeof this.#driverFactory.get === "function") {
            const existing = this.#driverFactory.get(agentId);
            return {
                agentId,
                managed: true,
                instantiated: Boolean(existing),
                running: existing ? undefined : false,
            };
        }
        return { agentId, managed: true, instantiated: undefined, running: undefined };
    }

    async health(agentId) {
        const driver = await this.#driver(agentId);
        if (typeof driver.health !== "function")
            return { ok: true, managed: false, agentId };
        return { agentId, ...(await driver.health()) };
    }

    async start(agentId, actorId) {
        return this.#operate("computer.started", agentId, actorId, async (driver) => {
            if (typeof driver.start === "function")
                return driver.start();
            if (typeof driver.health === "function")
                return driver.health();
            return { started: true, managed: false };
        });
    }

    async stop(agentId, actorId) {
        return this.#operate("computer.stopped", agentId, actorId, async (driver) => {
            if (typeof driver.stop !== "function")
                throw new Error("configured computer driver does not support stop");
            return driver.stop();
        });
    }

    async reset(agentId, actorId) {
        return this.#operate("computer.reset", agentId, actorId, async (driver) => {
            if (typeof driver.reset !== "function")
                throw new Error("configured computer driver does not support reset");
            return driver.reset();
        });
    }

    async #operate(eventType, agentId, actorId, operation) {
        if (!actorId)
            throw new Error("operator actor id is required");
        const driver = await this.#driver(agentId);
        await this.#audit.append({ type: `${eventType}.requested`, actor: actorId, subject: `computer:${agentId}`, data: { agentId } });
        try {
            const result = await operation(driver);
            await this.#audit.append({ type: eventType, actor: actorId, subject: `computer:${agentId}`, data: { agentId, ok: true } });
            return result;
        }
        catch (error) {
            await this.#audit.append({ type: `${eventType}.failed`, actor: actorId, subject: `computer:${agentId}`, data: { agentId, error: error.message } });
            throw error;
        }
    }

    async #driver(agentId) {
        const record = await this.#registry.ensure(agentId);
        const driver = this.#driverFactory?.forComputer
            ? await this.#driverFactory.forComputer(record)
            : this.#driverFactory
                ? await this.#driverFactory(record)
                : undefined;
        if (!driver)
            throw new Error(`no managed computer driver is configured for ${agentId}`);
        return driver;
    }
}
