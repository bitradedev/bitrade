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

## Production acceptance

Commit `546d7e45569a6aa5325401a3451468f964a23ac4` passed the [full GitHub workflow](https://github.com/bitradedev/bitrade/actions/runs/38673888682), including frontend reproducibility, self-hosted tests, product/Cloudflare/research-terminal checks and the deployment build. After a verified SQLite online backup, its VPS bundle was installed with SHA-256 `f4f6aa5a82cd91f6f7f61c73f54a78f200dc5df700754f08be328a939029c216`. The application service was active. Financial/Agent fingerprints before and after release matched exactly: `91d29a44045f4b6c8e1f0ab4554890221cbc0f84377d604549177d510e759a54`. Code rollback files are retained under `/opt/bitrade/releases/20261015-546d7e4`; the database was not reset or restored.

Cloudflare version `69a23978-c957-47c9-8d47-3e88dee6a85f` uses the same authenticated origin routing and updated `agents.md`. At 11:04 Beijing time, `/api/runtime`, `/api/public`, `/api/leaderboard` and `/agents.md` returned 200; runtime reported self-hosted mode, `liveEnabled=false`, connected BSC, writable storage and a successful scheduler round. The public Agent integration document contains the new sizing rules. No visual assets, namespace, DNS record, model, credentials or paid plan were changed in this release.

At 11:05 Beijing time, an unforced production discovery round recorded two fresh active Flap launches (`0xfe5b6a5b09ebf3b66c38da00d26d5f5558fa7777` and `0xa41957edf6245cdcdfd606676c8f69d143717777`), and both were present in the actual 12-token candidate set at ranks 4 and 5. Optional indicative curve-depth fields were also observed on real refreshed markets, with their estimate label. This verifies the deployed candidate path and market-input code; it does not prove either launch passed risk screening or should be bought. The user's earlier target addresses were not retroactively injected into candidates.

The ledger fingerprint still matched, with four old fills and no new orders or forced trades. Private decision-service counters had advanced to 40 successes and 81 failures. Existing valid decisions, some describing the former historical sizing rule, retained their original timestamps; no replacement decision was fabricated. There was no successful post-release natural AI decision or fill by this snapshot. Quote-based production sizing therefore remains awaiting a genuine eligible decision, and the external decision-service instability remains unresolved. The $150 success is an isolated regression test, not a live result. Production evidence is saved in ignored `.cloud-test-build/sizing-production-{after,natural}-546d7e4.json` and `sizing-live-2026-10-15T03-04-19-041Z.json`.

The paused automation stays paused. The already-authorized temporary SSH key remains within its existing October 17 08:00 Beijing expiry while the decision-service repair remains open; no new access was added. Remove it when that repair is completed, rather than requiring repeated key setup between connected repair steps.
