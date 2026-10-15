# Market pipeline repair, 2026-10-15

The user reported another missed Flap token, `0x0e0f350b280b6b14d7f17be7d168de5cfda57777` (安酱 / Binance-chan), and requested better discovery and evaluation coverage. This authorizes simulation-pipeline repairs, not forced buys or real trading.

## Observations and reproduction

At 11:16 Beijing time, the launch index retained this token's verified 10:53:39 creation and 10:54:49 sample (273 buys, 119 sells). There were no retained token risk, market, proposal, order or fill rows for its address. Complete historical per-round AI inputs were not retained; these observations do not prove a deliberate AI rejection, an attainable entry or a profitable exit.

Two isolated regressions failed against the preceding source:

- Flap activity selection considered only tokens created inside the latest 2,000-block window. Known older launches with current Portal trades were not updated; creation-age eviction could also remove them despite active trades. A verified older launch with a real current buy/sell sample was lost in the 48-row retention test.
- A supposedly targeted quote refresh still ran unrelated discovery first. The controlled test observed this unnecessary discovery call. That consumes requests and part of the short price/risk validity window before a decision or existing-position exit.

The VPS was also still using the Cloudflare orchestration profile: 45 requests per invocation, one market per general refresh, serial primary RPC and a 120-second launch scan. A slow AI call prevented other candidate risk collection. Priority risk completion returned without rechecking current prices. A failed preselected entry could return before discovery. These are pipeline constraints, not proof that every previously missed token had the same cause.

Private baseline: ignored `.cloud-test-build/market-pipeline-before-20261015.json`. The decision service still showed 40 successes and 86 failures, including HTTP 503 and long timeouts; that external issue remains separate.

## Changes and bounds

- Current Portal trades can refresh an already verified indexed launch outside the creation window. Up to three active launches enter the existing six-row selected set; fresh activity is retained before creation-age eviction, still capped at 48. Unknown trade addresses do not acquire invented creation evidence. Original creation/discovery times and historical risk/financial records are retained.
- Exact requested refreshes skip unrelated discovery. Failed preselected entry checks continue to other work when budget permits.
- VPS orchestration uses a bounded 128 requests per round, two primary-RPC requests in flight, two market jobs per batch, and a 30-second discovery/launch-scan minimum. This is a local workload bound, not a provider entitlement or a guaranteed wall-clock scan interval. Source pacing, HTTP 429/Retry-After, endpoint cooldown persistence, fixed-block verification and receipt-node checks still apply. Cloudflare retains 45/one/120-second defaults.
- General VPS refreshes prioritize the currently busiest fresh two-sided candidate and independently rotate exploration; the exploration cursor persists. Entry-decision selection also prioritizes observed activity over catalog insertion order. Neither activity nor a quote bypasses entry screening.
- Candidate risk work can proceed during an outstanding VPS AI call. After a priority risk check, actual prices are read again and an eligible due decision can start in that same round. Matching and held exits keep their priority. No evidence timestamp is extended or relabeled.
- Concurrent RPC success cannot clear a newer HTTP 429 cooldown from another in-flight request. Tests cover this race and queued-request suppression.

Trading remains paper-only. AI-selected amounts, exact bidirectional quotes, balance/fee checks, buy-impact ceiling, later-block slippage, freshness and existing exit rules remain. No user's supplied CA was injected into production candidates, no trade was forced, no ledger was reset and no UI/provider status text was added.

## Pre-release validation

142 Cloudflare tests, 106 product tests and six VPS tests pass, with core formatting and diff checks. New regressions cover older-launch retention without forged origin, targeted refresh isolation, bounded parallel RPC/cooldown races, complete exploration coverage across 12 candidates, persisted cursors, the separate request caps, post-risk same-round evaluation, and progress during failed or slow decisions. These controlled checks establish behavior; production freshness, source limits and natural decisions still require observation after deployment.
