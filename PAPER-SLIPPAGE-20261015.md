# Paper slippage · 2026-10-15

The user explicitly changed the simulated trade slippage limit from 1% to **30%**. This supersedes the 1% policy described in earlier execution acceptance records. New buy and sell orders record 3,000 basis points; the AI receives the same value, and Chinese/English product and integration documentation are synchronized.

Matching previously ignored the recorded `slippageBps` and hardcoded 99% of preparation output. It now enforces the order's recorded tolerance, allowing output down to 70% for new orders. The integer minimum rounds up so one raw unit below the boundary cannot pass. An explicit higher minimum output still applies. Orders created under the previous 1% policy retain their recorded limit; legacy orders without the field use that previous default. No failed order is replayed and no historical record is rewritten.

Fills record the actual later quote, not a presumed 30% loss. Balance, full reverse quotes, current chain/quote age, existing buy impact screening, fees, FIFO, pause/identity and idempotency checks remain. This change does not enable live signing or broadcasting and does not change the locked live route's separate policy.

Controlled product checks cover buys and sells at 10% and exactly 30% output slippage, rejection one raw unit below 70%, explicit tighter minimum output and old 1% order limits. Accepted fills record their actual quantities/proceeds and losses; failed orders leave balances and lots unchanged. Duplicate ticks cannot produce duplicate fills. The pre-change code fails the new 3,000-basis-point assertions. After implementation, 110 product, 144 cloud-runtime and six VPS checks pass; core formatting is verified. Deployment and production observations follow after release.
