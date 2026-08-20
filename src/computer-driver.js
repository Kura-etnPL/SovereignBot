export class UnavailableComputerDriver {
    async snapshot() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
    async navigate() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
    async click() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
    async type() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
    async key() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
    async scroll() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
    async typeSecret() {
        throw new Error("no browser/computer driver is configured for this agent");
    }
}

/**
 * A deterministic driver for tests, demos, and driver-contract development.
 * It deliberately records action metadata but never stores typed text/secret values.
 */
export class MemoryComputerDriver {
    #url = "about:blank";
    #elements = [];
    #actions = [];

    setPage(url, elements = []) {
        this.#url = url;
        this.#elements = elements.map((element, index) => ({
            ref: element.ref ?? `e${index + 1}`,
            backendRef: element.backendRef ?? `backend:${element.ref ?? `e${index + 1}`}`,
            role: element.role ?? "generic",
            name: element.name ?? "",
            type: element.type,
        }));
    }

    actions() {
        return structuredClone(this.#actions);
    }

    async snapshot() {
        this.#actions.push({ operation: "snapshot", url: this.#url });
        return { url: this.#url, elements: structuredClone(this.#elements) };
    }

    async navigate(url) {
        this.#url = url;
        this.#elements = [];
        this.#actions.push({ operation: "navigate", url });
        return { url };
    }

    async click(input) {
        this.#actions.push({
            operation: "click",
            ref: input.element.ref,
            backendRef: input.element.backendRef,
        });
        return { clicked: true };
    }

    async type(input) {
        this.#actions.push({
            operation: "type",
            ref: input.element.ref,
            characters: [...input.text].length,
        });
        return { typed: true, characters: [...input.text].length };
    }

    async key(input) {
        this.#actions.push({ operation: "key", ref: input.element?.ref, key: input.key });
        return { pressed: true };
    }

    async scroll(input) {
        this.#actions.push({ operation: "scroll", deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
        return { scrolled: true };
    }

    async typeSecret(input) {
        this.#actions.push({
            operation: "secret",
            ref: input.element.ref,
            characters: [...input.text].length,
        });
        return { supplied: true, characters: [...input.text].length };
    }
}

export function createMemoryComputerDriverFactory() {
    const drivers = new Map();
    return {
        forComputer(record) {
            let driver = drivers.get(record.agentId);
            if (!driver) {
                driver = new MemoryComputerDriver();
                drivers.set(record.agentId, driver);
            }
            return driver;
        },
        get(agentId) {
            return drivers.get(agentId);
        },
    };
}
