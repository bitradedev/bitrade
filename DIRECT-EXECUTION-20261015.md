# Direct paper execution · 2026-10-15

## User-selected behavior

The user requested that a positive AI decision proceed directly to a simulated order. Historical reference/current-price divergence is advisory, rather than an automatic rejection at 20%. Amounts remain AI-selected and constrained by actual quotes and available capital. Trading stays simulated; this does not authorize signing, broadcasting, forced buys, historical replay or another ledger reset.

## Implementation

- On the VPS, a persisted, unexpired buy/sell intent refreshes its market data and required buy screening, then enters existing order preparation in one continuous scheduled round. This replaces the unconditional evidence → screening → execution split across three alarms. A fresh invocation after the model response still provides a separate bounded execution budget.
- A stale screening report triggers a real source refresh. Its timestamp is never renewed locally. Known risks or absent required proof still block a new buy; sells remain independent of buy screening.
- Historical price divergence remains visible to the model. Exact amount buy and whole-output reverse quotes, balance plus gas/approval costs, verified quote age, a later block, maximum 2% buy impact and maximum 1% subsequent slippage remain enforced by the existing paper desk.
- When local request capacity cannot finish preparation, the same durable intent, creation time, expiry and idempotency key continue later. Expired, paused or account-changed intents cannot execute. Old failed intents/orders are not replayed.
- Model guidance clarifies that the requested amount is chosen before its exact executable quote is collected. Missing an exact-size quote in the model input is not evidence that the proposed size is impossible. The model may still choose hold when evidence is insufficient.
- The Cloudflare-only 45-request staged path is retained; the production API currently runs on the VPS. No public diagnostic UI or infrastructure status was added.

## Reproducible checks

The pre-fix regression rejected a buy when the current price was double the reference and left a VPS proposal pending after its evidence alarm. After the change, 109 product, 144 cloud-runtime and six VPS checks pass, with core formatting verified.

An integration fixture uses the real risk guard, durable proposal and paper desk: a $60 AI buy with a 121-second-old screening report is genuinely refreshed, queued in one scheduled round and filled at the new $2 quote (30 tokens, $60.01 including estimated gas), despite its $1 reference. A repeated execution yields one order and one fill; FIFO reconciles and no live order exists. This is controlled evidence, not a production trade or profit claim. Other checks cover buy/sell from all proposal stages, known/unknown risk rejection, stale-proof continuation, request-capacity continuation without changing deadline/key, account/pause/expiry invalidation and existing impact/slippage/reverse-quote failures.

At 04:39:48Z, before deployment, the production ledger already contained eight orders, seven fills and ten ledger entries. The most recent $35 buy had filled on the previous version. A further $25 trend buy also filled before this release. These trades must not be credited to this patch or removed.

## Deployment and production evidence

Commit `68554d484f6ed462672e344d67acb9ee68eb42f7` passed the [complete GitHub workflow](https://github.com/bitradedev/bitrade/actions/runs/38682829042). A verified online SQLite backup preceded installation. The VPS bundle hash is `f7529f6403942cb64088feeeb20db575692e5f5680db18186958a3b61267768a`; the service is active. Pre/post deployment financial, account and exit-plan fingerprints matched exactly: `489a593e5ccde664862a3d41e22e28f4f36ff94317a04945ec4d1964b1c1922e`, with nine orders, eight fills and eleven ledger entries. Previous code and the verification snapshots remain in `/opt/bitrade/releases/20261015-68554d4`. No database restore or reset occurred.

Cloudflare deployment `a69cdc58-1fef-459d-90e9-52a296955477` retains the original domain/proxy/bindings. Five public observations at 04:45:11–04:46:41Z returned 200 for runtime, public Agents and rankings; the chain advanced, live trading remained false, and the integration document matched the local file byte-for-byte. Natural post-release evaluations continued. The pre-release rebound sell intent was cancelled because its account/quote basis no longer matched; it was not replayed as a new order.

At 04:46:53.999Z the rebound Agent independently chose a $20 Roadster buy (`0x32fa5412ecef32fa5c7f3fae3e357d2baea77777`). At 04:46:58.086Z it had produced paper order `e08dd246cc9a7d27effeb85400324227`, and submission completed at 04:46:58.091Z: approximately 4.1 seconds from the model decision, through the new single-round VPS path. Its subsequent matching quote exceeded the existing 1% slippage/minimum-output requirement, so the order failed without a fill or debit. At 04:47:43Z there were ten orders, still eight fills and eleven ledger entries. This proves a natural direct submission, not a new production fill, profitability or sustained service reliability. The selected amount and 25%/12%/180-minute optional exit conditions were this model's choices, not new platform defaults.

Ignored evidence includes `.cloud-test-build/direct-entry-before-20261015.json`, `direct-entry-after-68554d4.json`, `direct-entry-public-68554d4.json` and the direct-entry build/test/deployment logs. The existing temporary SSH key keeps its original expiry, and the paused automation remains paused.
