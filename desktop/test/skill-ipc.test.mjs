import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ipcSource = readFileSync(fileURLToPath(new URL("../src/main/ipc.js", import.meta.url)), "utf8");
const preloadSource = readFileSync(fileURLToPath(new URL("../src/main/preload.cjs", import.meta.url)), "utf8");

test("Skill IPC contract exposes structured fields and native dialog channels", () => {
    assert.match(ipcSource, /"skill:exportViaDialog"/);
    assert.match(ipcSource, /"skill:importViaDialog"/);
    assert.match(ipcSource, /inputs.*steps.*expectedOutput.*requestedCapabilities.*validators.*source/s);
    assert.match(preloadSource, /exportViaDialog: invoke\("skill:exportViaDialog"\)/);
    assert.match(preloadSource, /importViaDialog: invoke\("skill:importViaDialog"\)/);
});

test("Skill IPC rejects authority fields while keeping requestedCapabilities declarative", () => {
    const validator = ipcSource.slice(ipcSource.indexOf("function validateSkillDocument"), ipcSource.indexOf("function validateTeachAction"));
    assert.match(validator, /inputs/); assert.match(validator, /steps/); assert.match(validator, /expectedOutput/); assert.match(validator, /requestedCapabilities/); assert.match(validator, /validators/); assert.match(validator, /source/); assert.match(validator, /https\?:\\\/\\\//);
    for (const forbidden of ["capabilityGrant", "token", "session", "credential", "path", "url"]) assert.doesNotMatch(validator, new RegExp(`(?:new Set\\([^)]*|exactKeys\\([^)]*)${forbidden}`));
});
