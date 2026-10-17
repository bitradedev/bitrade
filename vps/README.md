# BI Trade self-hosted paper service

当前交易网络配置：`BI_TRADE_CHAIN=robinhood`、`ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com`。保留 `BI_TRADE_SHOWCASE_PAUSED=true`。当前只接入 Pons V2 ETH/WETH 模拟路线；链数据与纸面交易按网络隔离，BSC 原实体不改名、不转换。旧网络只留后台备份，不向官网提供旧 CA、旧市场或历史入口。

This deployment starts an **empty** SQLite ledger. It does not import Cloudflare Durable Object users, custom Agents, balances, trades, risk records, or sessions. Keep the old Durable Object as a read-only archive; do not delete its namespace. There is no on-chain signing or broadcast path.

## Routing

`bitrade.site` remains the Cloudflare Worker and serves static assets. When `BI_TRADE_ORIGIN_URL` and the `BI_TRADE_ORIGIN_PROXY_TOKEN` secret are configured, its `/api/*` and `/mcp` requests go to `https://origin.bitrade.site`; the Worker cron then stops touching the old Durable Object. The origin DNS record must be an A record for the VPS in **DNS-only** mode. Cloudflare Workers cannot fetch an IP-address URL directly. The origin's HTTPS server checks the proxy token before forwarding to the Node service on `127.0.0.1:8797`; `/__admin/*` remains unavailable publicly.

Do not set `BI_TRADE_ORIGIN_URL` until DNS, hostname certificate, authenticated Nginx proxy, fresh ledger, and rollback have been verified. Changing that variable switches the public API to the new ledger. To roll back, remove it and redeploy the Worker. This restores access to the old Durable Object without merging or deleting either ledger. Do not switch back and forth after users start using the new ledger unless their data has been reconciled.

## Build and process

### Public trade candles

`node vps/build.mjs` also bundles `vps/dist/candles.mjs`. The loopback server exposes `/api/chart/history` and `/api/chart/stream` through the existing authenticated origin proxy. Copy the new server and both bundles together; keep `BI_TRADE_SHOWCASE_PAUSED=true`. Chart data uses `BI_TRADE_CHART_DB_PATH` or `${BI_TRADE_DB_PATH}.charts.sqlite`, separate from all financial entities. No migration/reset of the trading database is needed. Nginx must honor `X-Accel-Buffering: no` (the supplied template also disables proxy buffering).

The current free public HTTP RPC is shared by selected-market viewers. It scans on demand, normally 1.2 seconds after a completed round, sends SSE candle deltas, and stops after viewers disconnect. This is not an upstream WebSocket subscription or a latency guarantee. Production throughput still needs measurement. Eight distinct watched tokens and 64 streams are the current process bounds; historical reads and reconnects are rate-limited and honor upstream cooldown. No paid endpoint or subscription is created.

Candles are real execution OHLC and quote-side volume in ETH, with 1m/5m/15m/1h periods and at most 600 displayed bars. Curve buy prices exclude event fee (including snipe fee) and creator tax; curve sell prices add their reported fees back to obtain the exchange quote leg. V4 deltas are from the verified Pons factory-derived pool key. Both venues are scanned across graduation. Trade times/hashes are checked against canonical blocks; duplicate or incomplete scans cannot advance coverage. Empty periods remain empty, and paper orders never contribute exchange volume. No historical USD conversion is invented from the latest ETH/USD price.

First load scans up to 20,000 recent blocks, narrowed for dense ranges; dragging left or selecting Earlier backfills an adjacent bounded range. It is not a complete launch-to-present index. The UI retains scan/trade timestamps and previous bars through an outage. Restart retains chart history. A canonical-head mismatch rebuilds the affected chart cache only; accounts, orders, fees and risk records are untouched.

When a returning market's covered timestamp trails the actual chain head by over a minute, prioritize a bounded newest-first scan. Retain earlier cache rows, but serve only the currently verified contiguous interval; Earlier revalidates the adjacent range before older data rejoins it. A failed recent scan retains its original data and timestamp. This prevents hours of historical catch-up from blocking a returning visitor's current executions, without fabricating a covered gap or changing any financial data.

Use Node 24 and run `node vps/build.mjs` to bundle the existing platform for Node. Set a persistent random 32-byte hex `BI_TRADE_VAULT_KEY`, a private `BI_TRADE_DB_PATH`, `SITE_ORIGIN=https://bitrade.site`, `BI_TRADE_ASSET_DIR`, `BI_TRADE_PORT=8797`, and `BI_TRADE_RUN_SCHEDULER=true` in a root-owned environment file (mode 0600). Never commit it. The `bitrade` service user needs write access to the database directory, not to the environment file; systemd reads the file before dropping privileges. The unit binds to loopback only. Start paused for the first health check and unpause only after the public API path is verified.

The ACME webroot is `/var/www/bitrade-acme`. The Nginx HTTP block in `ip-acme.conf` serves challenges for the IP and `origin.bitrade.site`. Issue a separate Let's Encrypt certificate for the hostname using the webroot after the DNS record resolves. Install `domain-https.conf` only after its certificate exists. The renewal timer runs twice daily and calls `certbot renew` for both certificates, reloading Nginx on a successful renewal. Validate renewal with a dry run. The IP certificate alone does not authenticate the hostname.

## Acceptance before cutover

1. Run product, Cloudflare Workerd, and VPS tests against the exact release contents.
2. Verify the empty SQLite ledger has exactly the expected built-in Agent identities and no historical fills or custom owners.
3. Verify read-only BSC head, Flap discovery, AI call, and paper-only settings on the staged service. Do not force a trade to manufacture proof.
4. Verify origin TLS, token rejection, authenticated `/api/runtime`, public session creation, cookies, and read/write flow. Ensure no secret is printed in logs.
5. Deploy the Worker proxy switch. Verify `https://bitrade.site` API and pages, then observe scheduled rounds and natural paper fills/exits over time. A healthy API alone does not prove sustained free-tier request capacity or profitable trading.

`backup.mjs` uses SQLite's online backup API, checkpoints and verifies the snapshot, then renames it to a timestamped file. The backup timer runs daily; it never purges history. Keep the vault key protected separately because a database snapshot alone cannot decrypt Agent keys. Monitor free disk space, process restarts, certificate expiry, and HTTP errors. Never use a plain file copy of an active WAL database as the only backup.
