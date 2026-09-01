export const REMOTE_CONTROLLER_PROTOCOL = "sovereignbot.remote-controller/2";
export const REMOTE_CONTROLLER_PERSISTENCE_SCHEMA = "sovereignbot.remote-controller.persistence.v1";
export const REMOTE_CONTROLLER_NAVIGATION = Object.freeze(["team", "activity", "attention", "artifacts", "routines", "computer"]);
export const REMOTE_CONTROLLER_CONNECTION_STATES = Object.freeze(["offline", "pairing", "trusted", "reconnecting", "revoked", "expired"]);

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEVICE_ID = /^device_[0-9a-f]{16}$/i;

function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
}

function exactKeys(value, allowed, label) {
    object(value, label);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains an unsupported field`);
}

function id(value, label) {
    if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new Error(`${label} must be an opaque identifier`);
    return value;
}

export function validateAttentionDecisionInput(value) {
    exactKeys(value, new Set(["jobId"]), "attention decision");
    return { jobId: id(value.jobId, "jobId") };
}

export function validateComputerViewInput(value) {
    exactKeys(value, new Set(["projectId", "coworkerId"]), "Computer view");
    return { projectId: id(value.projectId, "projectId"), coworkerId: id(value.coworkerId, "coworkerId") };
}

export function validateRemoteControllerPersistence(value) {
    exactKeys(value, new Set(["schema", "controllerId", "deviceId", "displayName", "transport", "preferredView", "lastTeamId"]), "remote controller persistence");
    if (value.schema !== REMOTE_CONTROLLER_PERSISTENCE_SCHEMA) throw new Error("remote controller persistence schema is not supported");
    if (typeof value.controllerId !== "string" || !OPAQUE_ID.test(value.controllerId)) throw new Error("controllerId must be opaque");
    if (typeof value.deviceId !== "string" || !DEVICE_ID.test(value.deviceId)) throw new Error("deviceId is invalid");
    if (typeof value.displayName !== "string" || value.displayName.length > 120) throw new Error("displayName is invalid");
    if (!REMOTE_CONTROLLER_CONNECTION_STATES.includes(value.transport)) throw new Error("transport state is invalid");
    if (!REMOTE_CONTROLLER_NAVIGATION.includes(value.preferredView)) throw new Error("preferredView is invalid");
    if (value.lastTeamId !== undefined) id(value.lastTeamId, "lastTeamId");
    return structuredClone(value);
}

export function clearRemoteControllerPersistence(storage, key) {
    if (!storage || typeof storage.removeItem !== "function") throw new Error("controller storage is unavailable");
    storage.removeItem(key);
}
