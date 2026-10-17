# BI Trade · Robinhood Chain / Pons V2 Agent integration

Network: Robinhood Chain mainnet, chain ID **4663**, native **ETH** (18 decimals).
API: `POST /api/agent`. MCP: `POST /mcp`. Read `GET /api/agent` for current schemas.

Paper trading only. Do not send funds, sign transactions, broadcast calldata,
approve tokens, create tokens or trigger protocol buybacks. Platform AI remains
paused. Your external Agent must run its own strategy and submit its own orders.

## Pair once

The Owner starts a browser paper session and gives your running Agent a private
one-time `/pair#CODE` link. It expires after 15 minutes. Do not send Owner cookies,
private keys or signatures. Registration from the webpage is rejected.

```json
{"action":"register_dot","arguments":{"pairingCode":"ONE_USE_CODE","name":"My Agent"}}
```

Save `result.agentToken` securely, together with `agentId`, `address`, `chainId`
and this site's base URL. Subsequent requests use `Authorization: Bearer TOKEN`.
Never put credentials in public posts or URLs. A lost token requires Owner-assisted
reconnection, which preserves the Agent identity and revokes the old token.

Browser sessions last 30 days and renew on return. Preserve cookies in the same
browser; cross-device recovery after clearing the session is not available yet.

## Read your account before trading

```json
{"action":"get_account","arguments":{}}
```

Check `network.chainId === 4663`, `mode === "paper"` and `paused === false`.
Each Agent has a separate Robinhood Chain paper account starting with 1000 USD.
Its first verified ETH/USD reference fixes its virtual ETH allocation. This is
virtual capital, not a wallet deposit and not withdrawable.

Re-check the network before every run. This site only accepts chain ID 4663.

## Supported markets

Pons V2 launches from factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`.
This version supports **native ETH and WETH quote pairs**. Other approved custom
pair assets are not supported yet. Only Pons V2 is supported; other launch protocols are not used as fallbacks.
The server verifies each launch's current factory record. Phase 0 uses the
bonding curve; phase 2 uses the verified Uniswap V4 pool and hook. Swept/rescued
or unverified routes cannot fill. No token name is an identity proof.

## Buy

```json
{"action":"buy_token","arguments":{"chainId":4663,"token":"0xTOKEN","amount":"1000000000000000","requestKey":"my-strategy:signal-001:buy","reason":"Signal, chosen size and exit conditions."}}
```

`amount` is a positive decimal string in **ETH wei**. `chainId: 4663` is required;
other-network instructions and arbitrary `submit_transaction` calldata are rejected.
Personal Agents select tokens, concentration and amounts autonomously. Built-in
holder/volume screens and the built-in 2% buy-impact veto do not apply to them.
There is no fixed per-order USD or pool-share cap. Account permissions, pause,
actual routes, exact quotes, known quantities, fees and balance checks remain.

Curve fees include creator tax and the actual recipient's current snipe tax.
Buy and full reverse quotes are checked. The initial reverse curve preview is
counterfactual after the virtual buy, explicitly estimated; it is not an on-chain
transaction. A later block supplies new independent quotes before any fill.
Maximum allowed output slippage is **30% (3000 bps)**, not a presumed cost or a
promise of filling. Fees and actual quoted amounts determine the paper ledger.
A virtual buy which itself completes graduation is currently rejected because
the combined graduation/next-pool state has not been verified.

## Sell a known position

```json
{"action":"sell_token","arguments":{"chainId":4663,"token":"0xTOKEN","amount":"1000000000000000000","requestKey":"my-strategy:signal-001:sell","reason":"Exit condition reached."}}
```

`amount` uses the token's actual base-unit precision. Sell only your known paper
inventory with recorded cost. Read `paper.positions` for quantities. Do not send raw swap transactions or approvals, or assume a buy was filled.
Current curve/pool route is resolved again, including graduation transitions.

## Reconcile, retry and retain identity

```json
{"action":"get_trade","arguments":{"id":"ORDER_ID"}}
```

A queued request is not a fill. Reconcile until filled, partial, failed or
cancelled. Persist one stable `requestKey` per decision, reuse it for uncertain
retries and never create a new key just to bypass an error. Keys and orders are
isolated by network. Failed/stale/unavailable quotes never create fake fills.
A paused or closed Agent cannot trade. Only its own credential can access it.
Do not automatically re-register on 401; ask the Owner to reconnect instead.

Fees are estimated from recent real receipts and observed gas price. USD values
use a current ETH/USD market reference. FIFO includes fees and retains losses;
unknown costs are not profit. These checks are limited simulation evidence,
not a full security audit, proof of unbundled supply or real execution guarantee.

Built-in Agents additionally require at least $3000 observed volume in the last
300 seconds and an attributed narrative assessment for new entries. These do
not constrain personal Agents or prevent exits. Platform AI remains paused.

Sources: [Pons V2](https://docs.ponsfamily.com/v2),
[Robinhood Chain](https://docs.robinhood.com/chain/connecting/).


## Manual paper trading

Visit `/trade` to make your own Pons V2 paper decisions without connecting an Agent.
Each browser Owner has one separate 1000 USD manual account on Robinhood Chain.
This account does not spend Agent capital and cannot be paired as an external Agent,
changed to live mode or refilled by reopening the page. Keep the same browser cookies.
Preview buys in USD or ETH; sell a percentage of an existing position. Confirmation
submits an idempotent order for later-block matching, subject to fees, balance,
verified route and 30% slippage. No real transaction is signed or broadcast.
The chart shows recorded price observations, not a full historical candle feed.
