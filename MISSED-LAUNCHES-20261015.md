# Paper sizing and Flap candidate coverage, 2026-10-15

The user explicitly selected AI-chosen amounts constrained by actual quotes, rather than the old fixed 1% share of pool liquidity. This does not authorize real trading, a reset, forced entries, weaker evidence freshness, or fixed take-profit/stop-loss rules.

## Reproduced findings

At approximately 10:28 Beijing time, the existing VPS ledger contained three built-in Agents, four fills, four orders and seven ledger entries. The two completed paper round trips had approximately -$0.108822 and -$0.253577 realized P&L including recorded costs. One entry was only $0.60 before costs; its saved AI reason explicitly used the former 1% pool-reserve sizing limit. This mechanical constraint existed both in the AI context and in the entry guard. Small orders can be consumed by fees; larger orders are not a profitability guarantee.

For `0x151a674aa51ff8def71247eb9f6406152bf57777` (MJ / muse jensen), the launch index retained a 10:12 Beijing sample with 77 buys and 47 sells, but the token had no candidate, market, risk or proposal record at the inspection. A controlled 20-launch reproduction proved that rotating four slots over a moving, activity-ranked list can skip its busiest launch. The original code failed this reproduction. The repair reserves two slots for fresh two-sided activity and rotates exploration independently; no particular address or later price winner is hardcoded. Risk checks still determine whether a selected token can be considered for entry.

For `0x5f107c3aadf89fb784acaf997df3b8a0d9c87777`, a retained 04:13 Beijing report allowed limited paper screening, with graduation at 100%, approximately $8,706 quote reserve and 1% buy/sell tax. No buy proposal was retained. Complete per-round historical AI inputs were not stored, so its exact missed-entry cause cannot be reconstructed. It must not be described as a risk rejection or as an assured profitable opportunity. Independent current price/ATH data could not be fetched during this investigation.

The upstream decision service remained intermittent: the UTC-day private counters at inspection recorded 39 successes and 64 failures, including 90-second timeouts and HTTP 503. Candidate and sizing fixes do not resolve that external dependency. Public APIs were available and the scheduler was operating; trading remained paper-only.

Private, ignored evidence: `.cloud-test-build/missed-launches-20261015-{private,public}.json`, the read-only forensic helper and the failing-before/passing-after candidate reproduction. These contain no published credentials.

## Changed behavior

- AI chooses the amount using balance, signal, curve/pool information and costs. There is no fixed dollar cap or pool-liquidity percentage sizing cap.
- Preparation and later-block matching both require a fresh exact buy quote with known price impact no greater than 2%, plus an exact whole-output reverse-sell quote. The existing 1% later-block output slippage and available-balance checks remain. Reverse quotes and limited transfer simulations are evidence for paper execution, not a complete audit or real execution guarantee.
- Sells remain available without imposing the new buy-impact ceiling on existing inventory. Failed checks create no fill or debit. Existing orders, losses, fees and FIFO history are retained.
- Flap curve input distinguishes real quote reserves from indicative virtual curve depth. The latter includes the invariant's virtual term and is explicitly an estimate, never real funds or entry permission. Missing optional curve parameters produce no estimate.
- Two recently active Flap launches are prioritized ahead of exploration; stale, future, nonnumeric and one-sided samples do not qualify. Original evidence timestamps are preserved. Bounded selection diagnostics reuse the existing private discovery settings record.

## Validation before release

106 product tests, 135 Cloudflare tests and six VPS tests pass. The regression checks cover rejection at preparation and matching, missing reverse quotes, changed impact, old slippage enforcement, no incorrect charge/fill, a successful $150 isolated paper entry, fresh activity selection, 18/6-decimal curve-depth estimates and Flap entry/graduation/FIFO behavior above the old reserve-percentage cap. Core formatting, diff checks and the VPS bundle build pass. These controlled tests do not constitute new production trades, profit, complete discovery coverage or sustained uptime. Deployment evidence follows after release verification.
