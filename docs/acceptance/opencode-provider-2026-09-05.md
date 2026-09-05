# OpenCode adapter acceptance — 2026-09-05

## Scope

Added `desktop/src/main/opencode-provider.js`, an economy-provider adapter implementing `capabilities`, `models`, `health`, `start`, `continue`, and `cancel` for bounded text-only OpenAI-compatible chat completions.

- Zen uses the fixed official endpoint `https://opencode.ai/zen/v1/chat/completions` and an explicit allowlist of the five models documented as free and compatible with that chat endpoint at the time of review. The documented free Muse Spark contributor model is intentionally excluded because its endpoint is `responses`, outside this adapter's bounded chat-completions scope.
- Go uses the fixed official endpoint `https://opencode.ai/zen/go/v1/chat/completions` and an explicit allowlist of its documented chat-completions models. Go is a `$10/month` subscription; it is not represented as free.
- There is no paid fallback, arbitrary URL, model-name price inference, account lookup, registration, purchase, or live model call.
- Credentials come only from the injected trusted resolver and are used in-memory for the request. Health reports signed-out when the resolver has no credential. Errors/results do not echo credentials; fetch redirects are rejected and upstream error details are normalized. Timeout, caller abort, task cancellation, bounded input/response, and adapter-local continuation isolation are enforced.

## Evidence

Focused tests: `node --test test/opencode-provider.test.mjs`

Result: 5 adapter tests and 2 registration/credential-boundary tests passed. Tests mock transport and verify endpoint/model pinning, free-model allowlist, no paid fallback, Go chat endpoint, cancellation, continuation isolation, secret non-disclosure, incomplete-response rejection, and the real economy factory contract including `conversation: [{sender: "user", text: "context"}]`.

Official references reviewed 2026-09-05:

- https://opencode.ai/docs/zen/ — Zen endpoint/model table and free-model pricing notes.
- https://opencode.ai/docs/go/ — Go subscription, endpoint/model table, usage-limit fallback semantics (intentionally not enabled here).

## Known gap

The desktop runtime now supplies `createOpenCodeAdapterFactory` to its existing
Economy factory. Trusted config must explicitly name `opencode-zen-free` with mode
`free` or `opencode-go` with mode `fixed-subscription`, and an allowlisted model.
There is no renderer credential input or automatic activation. Credentials come
from exact `SOVEREIGNBOT_OPENCODE_ZEN_KEY` / `SOVEREIGNBOT_OPENCODE_GO_KEY` variables
or the corresponding existing OpenCode auth entry, without copying between them.

No Zen credential was present. The Go credential exists, but the account's optional
Use balance setting is unverified; execution remains blocked. The trusted operator
attestation `SOVEREIGNBOT_OPENCODE_GO_BALANCE_FALLBACK_DISABLED=1` must only be set
after verifying that setting is off; it does not itself alter account billing.
No real OpenCode request was made. In-memory continuations are isolated/bounded but
do not yet survive process restart. Health currently proves credential presence,
not remote account validity. Go subscription availability and free-model pricing
must be rechecked before enabling actual requests.
