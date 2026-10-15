# Decision-service recovery and client failure handling, 2026-10-15

The user requested repair of the remaining decision-service failures. Preserve the existing provider/model, simulation-only execution, account history and user-facing design. No provider switch, purchase, forced trade, new fixed exit or reset was authorized by this repair.

## Diagnosis

Read-only, non-trading probes used the VPS's existing configured host, key and model. At 11:51 Beijing time, authenticated model listing returned 200 in 571 ms with the configured model present. Strict Responses JSON, Chat Completions JSON and streaming Responses all returned 503 within approximately 0.3–1.0 seconds. Changing API families or enabling streaming did not resolve that failure window. No credential was printed or sent to a different host.

At 11:58, a minimal Responses request returned 200 in 11.1 seconds. A controlled same-model comparison at 12:05–12:06 completed valid JSON on all four variants: plain (9.0 s), strict schema (26.7 s), low reasoning (25.3 s) and the original strict-schema/low-reasoning combination (22.4 s). These observations refute a deterministic incompatibility with the original options; they do not isolate the provider's internal account, routing or capacity cause. The original model and strict decision contract remain unchanged. The [official structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) was used to check protocol shape, not as evidence that the third-party provider supports every option.

At 12:06:38, actual production diagnostics had advanced from 40 to 48 successful decisions. All three built-in Agents had new, unforced evaluations; two latest valid decisions returned in approximately 20.4 and 22.9 seconds and selected hold. One Agent was already assessing its next round. Four original fills/orders remained, with no forced new trade. Natural recovery occurred **before** this client's new failure-handling patch and must not be credited to it. Some intervening requests still timed out after 90 seconds, so sustained service recovery was not established.

Private evidence is ignored: `.cloud-test-build/ai-repair-before-20261015.json` and the filtered diagnostic tool records. Probe scripts never called the trading API or wrote decision/fill rows.

## Client repairs

- Non-success HTTP response bodies are cancelled without parsing/retaining provider messages, releasing the failed response resource. Cleanup errors cannot mask the actual HTTP failure. This corrects a client resource-handling gap; it is not proof that unconsumed bodies caused the provider's 503 responses.
- HTTP Retry-After is parsed at response receipt using the shared numeric/HTTP-date parser. A valid future server deadline is retained privately and the Agent schedules no earlier than both that deadline and its existing bounded retry interval. Authentication failures do not become automatic timed recovery. Invalid/past headers retain the existing retry behavior.
- The parser was extracted into the product library and re-exported by Cloudflare, retaining existing public-data/RPC semantics. No evidence age, financial data, quote checks, cadence on successful calls, endpoint/model, public diagnostic field or UI asset was changed.

## Validation

108 product tests, 142 cloud tests and six VPS tests pass. Focused checks cover response cleanup (including cleanup rejection), ignored sensitive provider bodies, both retry-header forms, authentication handling, persisted retry deadlines, unchanged real evaluation time, no extra call during the wait and unchanged virtual balance. Existing price/risk freshness, FIFO, quote matching, exit and public-UI regressions remain passing. Production rollout and later observations are recorded below.
