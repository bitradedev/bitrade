# Decision-service recovery and client failure handling, 2026-10-15

The user requested repair of the remaining decision-service failures. Preserve the existing provider/model, simulation-only execution, account history and user-facing design. No provider switch, purchase, forced trade, new fixed exit or reset was authorized by this repair.

## Diagnosis

Read-only, non-trading probes used the VPS's existing configured host, key and model. At 11:51 Beijing time, authenticated model listing returned 200 in 571 ms with the configured model present. Strict Responses JSON, Chat Completions JSON and streaming Responses all returned 503 within approximately 0.3–1.0 seconds. Changing API families or enabling streaming did not resolve that failure window. No credential was printed or sent to a different host.

At 11:58, a minimal Responses request returned 200 in 11.1 seconds. A controlled same-model comparison at 12:05–12:06 completed valid JSON on all four variants: plain (9.0 s), strict schema (26.7 s), low reasoning (25.3 s) and the original strict-schema/low-reasoning combination (22.4 s). These observations refute a deterministic incompatibility with the original options; they do not isolate the provider's internal account, routing or capacity cause. The original model and strict decision contract remain unchanged. The [official structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) was used to check protocol shape, not as evidence that the third-party provider supports every option.

At 12:06:38, actual production diagnostics had advanced from 40 to 48 successful decisions. All three built-in Agents had new, unforced evaluations; two latest valid decisions returned in approximately 20.4 and 22.9 seconds and selected hold. One Agent was already assessing its next round. Four original fills/orders remained, with no forced new trade. Natural recovery occurred **before** this client's new failure-handling patch and must not be credited to it. Some intervening requests still timed out after 90 seconds, so sustained service recovery was not established.

Private evidence is ignored: `.cloud-test-build/ai-repair-before-20261015.json` and the filtered diagnostic tool records. Probe scripts never called the trading API or wrote decision/fill rows.

## Client repairs

- Non-success HTTP response bodies are cancelled without parsing/retaining provider messages, releasing the failed response resource. Cleanup errors cannot mask the actual HTTP failure. This corrects a client resource-handling gap; it is not proof that unconsumed bodies caused the provider's 503 responses.
- HTTP Retry-After is parsed at response receipt using the shared numeric/HTTP-date parser. A valid future server deadline is retained privately and the Agent schedules no earlier than both that deadline and its existing bounded retry interval. Authentication failures retain their existing category and do not accept a server retry deadline. Invalid/past headers retain the existing retry behavior.
- The parser was extracted into the product library and re-exported by Cloudflare, retaining existing public-data/RPC semantics. No evidence age, financial data, quote checks, cadence on successful calls, endpoint/model, public diagnostic field or UI asset was changed.

## Validation

108 product tests, 142 cloud tests and six VPS tests pass. Focused checks cover response cleanup (including cleanup rejection), ignored sensitive provider bodies, both retry-header forms, authentication handling, persisted retry deadlines, unchanged real evaluation time, no extra call during the wait and unchanged virtual balance. Existing price/risk freshness, FIFO, quote matching, exit and public-UI regressions remain passing. Production rollout and later observations are recorded below.

## Rollout and observed behavior

Commit `a1615034dc41672f3a9128477661750206101019` passed the [complete GitHub workflow](https://github.com/bitradedev/bitrade/actions/runs/38680037701). After a verified SQLite online backup, the VPS bundle was installed with SHA-256 `c050d94221adbb4ece0dc878544e54be9a2f141d34c4069adfa5a6922d22753b`. Pre/post Agent, financial and exit-record fingerprints matched exactly: `e37038b8beec7e5661205c38b19cc50fdffb5b380a2a949c6ec063bd50fe6537`. The service remained active; previous code is retained at `/opt/bitrade/releases/20261015-a161503`. Cloudflare version `590f440a-a892-4eee-a0cd-633b1cd674a7` uses unchanged routing, bindings and frontend assets. The earlier locally committed market acceptance record was also successfully pushed after using HTTP/1.1 for the transient GitHub transport issue; repository configuration was not changed.

After restart, new natural decisions completed at 12:12:27 (rebound), 12:13:01 (rotation) and 12:13:34 (trend), taking 13.65, 30.21 and 31.32 seconds respectively. All selected hold. The 12:13:47 private snapshot recorded 55 UTC-day successes; the recent failure added during deployment was an explicitly cancelled in-flight request, not a newly observed upstream 503. Nine public samples at 12:12:33–12:14:46 returned 200 and showed actual evaluation timestamps advancing, with the next rotation assessment in flight by the last sample. These observations establish short-window natural evaluation recovery, not sustained reliability or profitability.

Before this patch was installed, the previous recovered production service had also generated autonomous $20 and $60 buy proposals. The $20 proposal failed current risk validation without creating an order; the $60 proposal created an order which failed the unchanged 20% reference/current-price coherence check before matching. Four original fills and seven ledger entries remained; there was one additional genuine failed order (five total) and no new fill or charge from those attempts. The chosen amounts and exits were AI proposals, not newly imposed global defaults. Do not attribute those pre-release proposals to the HTTP cleanup patch or count them as executed trades.

Ignored evidence: `.cloud-test-build/ai-repair-after-a161503.json` and `.cloud-test-build/ai-recovery-public-a161503.json`, alongside the earlier baseline. Temporary diagnostic/upload files were removed from the VPS. The same existing SSH key remains within its October 17 08:00 Beijing expiry while external reliability and any alternate-endpoint choice remain open; no additional access was created. The paused automation remains paused.
