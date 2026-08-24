#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const DEFAULT_ROUNDS = 3;
const MAX_ROUNDS = 12;
const ROUND_TIMEOUT_MS = 5 * 60_000;

function parseRounds(value) {
    if (value === undefined || value === "")
        return DEFAULT_ROUNDS;
    const rounds = Number(value);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)
        throw new Error(`SOVEREIGNBOT_SOAK_ROUNDS must be an integer between 1 and ${MAX_ROUNDS}`);
    return rounds;
}

const rounds = parseRounds(process.env.SOVEREIGNBOT_SOAK_ROUNDS);
console.log(`SovereignBot RC soak: ${rounds} deterministic full-suite rounds, serialized test concurrency.`);

for (let round = 1; round <= rounds; round += 1) {
    console.log(`\n=== RC soak round ${round}/${rounds} ===`);
    const startedAt = Date.now();
    const result = spawnSync(
        process.execPath,
        ["--test", "--test-concurrency=1", "tests/*.test.js"],
        {
            stdio: "inherit",
            windowsHide: true,
            timeout: ROUND_TIMEOUT_MS,
            env: {
                ...process.env,
                SOVEREIGNBOT_RC_SOAK_ROUND: String(round),
            },
        },
    );

    if (result.error) {
        if (result.error.code === "ETIMEDOUT")
            throw new Error(`RC soak round ${round} exceeded ${ROUND_TIMEOUT_MS}ms`);
        throw result.error;
    }
    if (result.status !== 0)
        process.exit(result.status ?? 1);

    console.log(`=== RC soak round ${round}/${rounds} passed in ${Date.now() - startedAt}ms ===`);
}

console.log(`\nRC soak passed: ${rounds}/${rounds} serialized full-suite rounds.`);
