import { ComputerActionRefusedError } from "./computer-gateway.js";

export class TaskBoundComputerGateway {
    #inner;
    #taskResolver;
    #registry;
    #governor;

    constructor({ inner, taskResolver, registry, governor }) {
        this.#inner = inner;
        this.#taskResolver = taskResolver;
        this.#registry = registry;
        this.#governor = governor;
    }

    listComputers() {
        return this.#inner.listComputers();
    }

    agentCredentials(agentId) {
        return this.#inner.agentCredentials(agentId);
    }

    operatorCredentials() {
        return this.#inner.operatorCredentials();
    }

    authenticateAgent(agentId, token) {
        return this.#inner.authenticateAgent(agentId, token);
    }

    authenticateOperator(token) {
        return this.#inner.authenticateOperator(token);
    }

    control(agentId) {
        return this.#inner.control(agentId);
    }

    takeControl(agentId, actorId) {
        return this.#inner.takeControl(agentId, actorId);
    }

    releaseControl(agentId, actorId) {
        return this.#inner.releaseControl(agentId, actorId);
    }

    async snapshot(agentId, taskId) {
        await this.#assertActiveTask(agentId, taskId, "snapshot");
        return this.#inner.snapshot(agentId, taskId);
    }

    async navigate(agentId, taskId, url) {
        await this.#assertActiveTask(agentId, taskId, "navigate");
        return this.#inner.navigate(agentId, taskId, url);
    }

    async click(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "click");
        return this.#inner.click(agentId, taskId, input);
    }

    async type(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "type");
        return this.#inner.type(agentId, taskId, input);
    }

    async key(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "key");
        return this.#inner.key(agentId, taskId, input);
    }

    async scroll(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "scroll");
        return this.#inner.scroll(agentId, taskId, input);
    }

    async listFiles(agentId, taskId, path) {
        await this.#assertActiveTask(agentId, taskId, "list_files");
        return this.#inner.listFiles(agentId, taskId, path);
    }

    async readFile(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "read_file");
        return this.#inner.readFile(agentId, taskId, input);
    }

    async writeFile(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "write_file");
        return this.#inner.writeFile(agentId, taskId, input);
    }

    async requestHelp(agentId, taskId, reason) {
        await this.#assertActiveTask(agentId, taskId, "request_help");
        return this.#inner.requestHelp(agentId, taskId, reason);
    }

    async requestSecret(agentId, taskId, input) {
        await this.#assertActiveTask(agentId, taskId, "request_secret");
        return this.#inner.requestSecret(agentId, taskId, input);
    }

    async supplySecret(agentId, actorId, requestId, text) {
        const request = await this.#registry.secretRequest(agentId);
        if (!request || request.id !== requestId)
            return this.#inner.supplySecret(agentId, actorId, requestId, text);
        await this.#assertActiveTask(agentId, request.taskId, "supply_secret");
        return this.#inner.supplySecret(agentId, actorId, requestId, text);
    }

    async #assertActiveTask(agentId, taskId, operation) {
        let reason;
        if (!taskId) {
            reason = "computer action is not bound to a task";
        }
        else {
            const task = await this.#taskResolver(taskId);
            if (!task) {
                reason = `computer action is not bound to a known task: ${taskId}`;
            }
            else {
                const owner = task.ownerAgentId ?? task.assignedAgentId;
                if (owner !== agentId)
                    reason = `computer task ${taskId} is not owned by agent ${agentId}`;
                else if (task.status !== "running")
                    reason = `computer task ${taskId} is not running (current status: ${task.status})`;
            }
        }

        if (!reason)
            return;
        const decision = await this.#governor.authorize({
            category: "computer",
            operation,
            target: `computer:${agentId}`,
            agentId,
            taskId,
            hardDeny: reason,
        });
        throw new ComputerActionRefusedError(reason, decision);
    }
}
