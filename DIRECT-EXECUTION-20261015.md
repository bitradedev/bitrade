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

At 04:39:48Z, before deployment, the production ledger already contained eight orders, seven fills and ten ledger entries. The most recent $35 buy had filled on the previous version. Its real records and any later natural changes must not be credited to this patch or removed. The actual release and post-release observations will be recorded after deployment.
