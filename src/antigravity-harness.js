import { antigravityAdapterFor, registerAgentAntigravityAdapter } from "./antigravity-registry.js";

const MAX_TEXT = 20_000;
const MAX_CONTINUATION = 512;
const PRIVATE_RESULT_KEYS = new Set(["sessionId", "conversationId", "profileDir", "storageState", "cookies", "continuationUrl", "accountId", "accountNamespace"]);

export { registerAgentAntigravityAdapter };

function safeText(value, label) {
    if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT)
        throw new Error(`Antigravity ${label} is invalid`);
    return value;
}

function safeContinuation(value) {
    if (typeof value !== "string" || !value || value.length > MAX_CONTINUATION || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))
        throw new Error("Antigravity continuation is invalid");
    return value;
}

function safeConversation(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-32).map((message) => ({
        sender: safeText(String(message?.sender ?? "unknown"), "conversation sender"),
        text: safeText(String(message?.text ?? ""), "conversation text"),
        ...(typeof message?.createdAt === "string" ? { createdAt: message.createdAt.slice(0, 40) } : {}),
    }));
}

function safeInstruction(value) {
    return safeText(value, "instruction")
        .replace(/\bconv_[A-Za-z0-9][\w:-]{0,127}\b/g, "[internal-conversation]");
}

function requestForTask(task, agent) {
    const input = task?.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Antigravity task input must be an object");
    return {
        title: safeText(String(task.title ?? "Antigravity task"), "task title").slice(0, 240),
        instruction: safeInstruction(String(input.instruction ?? "")),
        conversation: safeConversation(input.conversation),
        model: typeof agent.harness?.model === "string" && agent.harness.model ? agent.harness.model : "antigravity",
    };
}

function safeOutput(result) {
    if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Antigravity adapter returned an invalid result");
    for (const key of PRIVATE_RESULT_KEYS) {
        if (Object.hasOwn(result, key))
            throw new Error(`Antigravity adapter leaked private result field: ${key}`);
    }
    const text = result.text ?? result.output?.text;
    if (typeof text !== "string") throw new Error("Antigravity adapter returned no text");
    const output = { text: text.slice(0, MAX_TEXT) };
    if (result.usage && typeof result.usage === "object" && !Array.isArray(result.usage))
        output.usage = { ...result.usage };
    return { output, continuationRef: result.continuationRef === undefined ? undefined : safeContinuation(result.continuationRef) };
}

export class AntigravityHarness {
    constructor(agent) { this.agent = agent; }

    async run(context) {
        const adapter = antigravityAdapterFor(this.agent);
        if (!adapter) throw new Error("Antigravity adapter is not registered");
        const request = requestForTask(context.task, this.agent);
        const prior = context.task.harnessState?.kind === "antigravity"
            ? safeContinuation(context.task.harnessState.continuationRef) : undefined;
        let cancelRequested = false;
        const cancel = async () => {
            cancelRequested = true;
            try { await adapter.cancel({ continuationRef: prior }); } catch {}
        };
        const onAbort = () => void cancel();
        context.signal.addEventListener("abort", onAbort, { once: true });
        try {
            if (context.signal.aborted) { await cancel(); return { ok: false, error: "Antigravity task cancelled" }; }
            const operation = prior
                ? adapter.continue({ ...request, continuationRef: prior, signal: context.signal })
                : adapter.start({ ...request, signal: context.signal });
            const aborted = new Promise((_, reject) => {
                if (context.signal.aborted) reject(new Error("Antigravity task cancelled"));
                else context.signal.addEventListener("abort", () => reject(new Error("Antigravity task cancelled")), { once: true });
            });
            const result = await Promise.race([operation, aborted]);
            if (cancelRequested || context.signal.aborted) return { ok: false, error: "Antigravity task cancelled" };
            const normalized = safeOutput(result);
            if (normalized.continuationRef)
                await context.updateHarnessState?.({ kind: "antigravity", continuationRef: normalized.continuationRef });
            return { ok: true, output: normalized.output };
        }
        catch (error) {
            if (cancelRequested || context.signal.aborted) return { ok: false, error: "Antigravity task cancelled" };
            return { ok: false, error: String(error?.message ?? error).slice(0, 800) };
        }
        finally { context.signal.removeEventListener("abort", onAbort); }
    }
}
