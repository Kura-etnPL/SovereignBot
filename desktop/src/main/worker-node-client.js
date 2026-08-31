// Main-process-only bridge to the Core Worker Node HTTP client. The renderer never
// receives this module or a client instance; credentials stay inside worker-node-store.
export {
    createWorkerNodeClient,
    workerNodeTransportError,
} from "../../vendor/core/src/worker-node-client.js";
