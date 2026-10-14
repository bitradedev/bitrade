import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual, createHash } from 'node:crypto';
import { CloudStore } from './store.mjs';
import { SelfHostedStore } from '../vps/store.mjs';
import { EncryptedVault } from '../bi-trade/lib/vault-core.mjs';
import { createPlatformCore } from '../bi-trade/platform-core.mjs';
import { TokenRiskGuard } from '../bi-trade/lib/token-risk-core.mjs';
import { OpenAIPlanner, validateConfig, reserveAICall } from '../bi-trade/lib/ai-provider.mjs';
import { recordAIHealth } from './ai-health.mjs';
import { CloudMarket } from './market.js';
import { CloudRpc } from './rpc.mjs';
import { GmgnHTTP } from './gmgn.mjs';
import { marketFetch } from './market-source.mjs';
import { PublicBscData } from './public-data.mjs';
import { MemeBscData } from './meme-data.mjs';
import { IOBudget } from './io-budget.mjs';
import { runScheduledRound } from './scheduler.mjs';
import { handleFetch } from './bridge.mjs';
import { mergeLedger } from './import.mjs';
import { resetShowcasePaper } from './showcase-reset.mjs';

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (value: any, status = 200) =>
  Response.json(value, { status, headers: { ...SECURITY, 'Cache-Control': 'no-store' } });
function same(a: string, b: string) {
  return (
    a &&
    b &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
const ASSET_ROUTES: any = {
  '/': 'intro.html',
  '/home': 'index.html',
  '/dashboard': 'index.html',
  '/docs': 'index.html',
  '/pair': 'index.html',
  '/playbook': 'index.html',
  '/intro': 'intro.html',
  '/intro.html': 'intro.html',
};

export class TradingPlatform extends DurableObject<any> {
  store: any;
  io: any;
  app: any = null;
  market: any = null;
  risk: any = null;
  initializing: any = null;
  working: any = null;
  decisionTask: any = null;
  riskRequestReserve = 32;
  importing = false;
  appReadOnly = false;
  wakeStatus: any = null;
  wakeRecovery: any = null;
  constructor(ctx: any, env: any) {
    super(ctx, env);
    const Store = env.BI_TRADE_SELF_HOSTED === 'true' ? SelfHostedStore : CloudStore;
    this.store = new Store(ctx.storage, {
      readOnlyUntil: Date.parse(env.BI_TRADE_STORAGE_READ_ONLY_UNTIL ?? '') || 0,
    });
    this.io = new IOBudget(45);
  }
  initialize() {
    if (this.app && this.appReadOnly !== this.store.readOnly) {
      this.app = null;
      this.market = null;
      this.risk = null;
    }
    if (this.app) return Promise.resolve(this.app);
    if (this.initializing) return this.initializing;
    this.initializing = this.ctx
      .blockConcurrencyWhile(async () => {
        if (!this.env.BI_TRADE_VAULT_KEY) throw Error('Missing vault secret');
        if (!this.store.readOnly)
          resetShowcasePaper(this.store, this.env.BI_TRADE_SHOWCASE_RESET_ID);
        const vault = new EncryptedVault(Buffer.from(this.env.BI_TRADE_VAULT_KEY, 'base64'));
        const source = new GmgnHTTP(
            this.env.GMGN_RELAY_URL ? this.env.GMGN_RELAY_TOKEN : this.env.GMGN_API_KEY,
            {
              store: this.store,
              fetchImpl: marketFetch(this.env, this.io.fetch),
            },
          ),
          rpc = new CloudRpc(this.env.BSC_RPC_URL, {
            receiptUrl: this.env.BSC_RECEIPT_RPC_URL,
            backupUrl: this.env.BSC_PRICE_BACKUP_RPC_URL ?? this.env.BSC_RECEIPT_RPC_URL,
            fetchImpl: this.io.fetch,
            store: this.store,
          }),
          memeData =
            this.env.BI_TRADE_MEME_ONLY === 'true'
              ? new MemeBscData(this.store, rpc, { fetchImpl: this.io.fetch })
              : null,
          publicData =
            this.env.BI_TRADE_PUBLIC_MARKET === 'true'
              ? new PublicBscData(this.store, rpc, {
                  fetchImpl: this.io.fetch,
                  sharedReader: memeData,
                })
              : null,
          market = new CloudMarket(this.store, {
            rpc,
            gmgn: source,
            publicData,
            memeData,
            memeOnly: this.env.BI_TRADE_MEME_ONLY === 'true',
            onGap: () => this.app?.paper.gap(),
          });
        const risk = new TokenRiskGuard(this.store, {
            maxTokensPerTick: 1,
            source: {
              label: (token: string) =>
                memeData?.flap?.supports(token)
                  ? 'Flap Portal · BSC RPC'
                  : memeData?.supports(token)
                    ? 'BSC Meme · Four.meme / GeckoTerminal · Honeypot.is · RPC'
                    : publicData?.supports(token)
                      ? 'BSC RPC · DEX Screener · Honeypot.is'
                      : 'GMGN API',
              riskReport: (token: string) =>
                memeData?.supports(token)
                  ? memeData.riskReport(token)
                  : publicData?.supports(token)
                    ? publicData.riskReport(token)
                    : null,
              info: (...args: any[]) => source.info(...args),
              holders: (...args: any[]) => source.holders(...args),
              security: (...args: any[]) => source.security(...args),
              close: () => source.close(),
            },
          }),
          planner = new OpenAIPlanner({
            timeoutMs: 90000,
            fetchImpl: this.io.fetch,
            onDiagnostic: (sample: any) => recordAIHealth(this.store, sample),
          });
        const configReader = () =>
          this.env.BI_TRADE_AI_API_KEY
            ? validateConfig({
                apiKey: this.env.BI_TRADE_AI_API_KEY,
                model: this.env.BI_TRADE_AI_MODEL,
                baseUrl: this.env.BI_TRADE_AI_BASE_URL,
                intervalMinutes: 1,
                dailyCalls: null,
              })
            : null;
        this.market = market;
        this.risk = risk;
        this.app = await createPlatformCore({
          store: this.store,
          vault,
          gateway: market,
          riskGuard: risk,
          origin: this.env.SITE_ORIGIN,
          preserveQueued: true,
          readOnly: this.store.readOnly,
          liveEnabled: false,
          rpc: { balance: async () => 0n },
          rateLimit: (...args: any[]) => this.store.rateLimit(...args),
          showcaseOptions: {
            configReader,
            planner,
            maxAgentsPerRun: 1,
            deferExecution: true,
            readOnly: this.store.readOnly,
          },
          assetReader: async (name: string) =>
            Buffer.from(
              await (
                await this.env.ASSETS.fetch(new Request(this.env.SITE_ORIGIN + '/' + name))
              ).arrayBuffer(),
            ),
        });
        this.app.paper.maxOrdersPerTick = 1;
        this.appReadOnly = this.store.readOnly;
        for (const a of this.store
          .all('agents')
          .filter((a: any) => !this.store.readOnly && a.source === 'builtin')) {
          const paused = this.env.BI_TRADE_SHOWCASE_PAUSED === 'true';
          if (a.paused !== paused) this.store.put('agents', { ...a, paused });
        }
        return this.app;
      })
      .finally(() => {
        this.initializing = null;
      });
    return this.initializing;
  }
  async arm(delay = 20000) {
    if (this.store.readOnly) return;
    const next = await this.ctx.storage.getAlarm(),
      now = Date.now(),
      overdue = next !== null && next <= now,
      rearmed = next === null || overdue || next > now + delay;
    if (rearmed) {
      await this.ctx.storage.setAlarm(now + delay);
      this.store.budget.record(1);
    }
    if (overdue) this.wakeRecovery = { at: now, previousAt: next, nextAt: now + delay };
    this.wakeStatus = {
      checkedAt: now,
      previousAt: next,
      nextAt: rearmed ? now + delay : next,
      rearmed,
      lastRecovery: this.wakeRecovery,
    };
  }
  async fetch(request: Request) {
    return this.io.run('http', () => this.handleRequest(request));
  }
  async handleRequest(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/__admin/import') return await this.importLedger(request);
      if (url.pathname === '/__admin/check-ai') return await this.checkAI(request);
      if (this.importing) return json({ error: '账本正在迁移，请稍后重试' }, 503);
      if (!this.working && !this.decisionTask) this.store.prepareWriteBudget();
      const app = await this.initialize();
      if (
        this.store.readOnly &&
        !['GET', 'HEAD'].includes(request.method) &&
        url.pathname !== '/api/session'
      )
        return json(
          {
            error: '服务暂处于只读保护，写入额度恢复后自动继续。历史资金与成交已保留。',
            retryAt: this.store.protectionUntil,
          },
          503,
        );
      await this.arm();
      if (url.pathname === '/api/runtime')
        return json({
          platform: this.env.BI_TRADE_SELF_HOSTED === 'true' ? 'self-hosted' : 'cloudflare',
          wakeup: this.wakeStatus,
          storageProtection: {
            readOnly: this.store.readOnly,
            retryAt: this.store.readOnly ? this.store.protectionUntil : null,
            writeBudget:
              this.env.BI_TRADE_SELF_HOSTED === 'true' ? null : this.store.budget.snapshot(),
          },
          liveEnabled: false,
          aiConfigured: !!this.env.BI_TRADE_AI_API_KEY,
          showcaseReset: this.store.get('cloud-settings', 'showcase-paper-reset'),
          marketConfigured: !!(
            this.env.GMGN_API_KEY ||
            this.market.publicData ||
            (this.env.GMGN_RELAY_URL && this.env.GMGN_RELAY_TOKEN)
          ),
          market: this.market.statuses()[0],
          nativeUsd: this.market.fxValue?.usd ?? null,
          nativeFxAt: this.market.fxValue?.at ?? null,
          nativeFxSource: this.market.fxValue?.source ?? null,
          marketService: this.market.gmgn.status(),
          marketTransport: this.env.GMGN_RELAY_URL ? 'private-relay' : 'cloudflare-fetch',
          publicMarketEnabled: Boolean(this.market.publicData),
          publicMarketSources: (this.market.memeData ?? this.market.publicData)?.status() ?? [],
          marketScope: this.market.marketScope(),
          rpcSources: [
            { source: 'BSC price RPC', ...this.market.rpc.status() },
            ...(this.market.rpc.backupRpc
              ? [{ source: 'BSC price backup RPC', ...this.market.rpc.backupRpc.status() }]
              : []),
            ...(this.market.rpc.receiptRpc
              ? [{ source: 'BSC receipt RPC', ...this.market.rpc.receiptRpc.status() }]
              : []),
          ],
          networkBudget: this.io.lastAlarm,
          decisionBudget: this.io.lastDecision,
          decisionInFlight: Boolean(this.decisionTask),
          marketRetryAt: this.store.get('cloud-settings', 'gmgn-budget')?.cooldown ?? null,
          marketRetryReason: this.store.get('cloud-settings', 'gmgn-budget')?.errorCode ?? null,
          candidates: {
            known: this.market.markets().filter((m: any) => this.market.isEntryCandidate(m.address))
              .length,
            verified: this.market
              .markets()
              .filter(
                (m: any) => this.market.isEntryCandidate(m.address) && m.quality === 'verified',
              ).length,
            fresh: app.showcase.freshMarkets().length,
            eligible: app.showcase
              .freshMarkets()
              .filter((m: any) => this.risk.snapshot(m.address, m.priceUsd).buyAllowed).length,
            screening: this.market
              .markets()
              .filter((m: any) => this.market.isEntryCandidate(m.address))
              .map((m: any) => {
                const r = this.risk.snapshot(m.address, m.priceUsd);
                return {
                  token: m.address,
                  symbol: m.symbol,
                  state: r.state,
                  buyAllowed: r.buyAllowed,
                  fetchedAt: r.fetchedAt ?? null,
                  reasons: r.reasons,
                  policy: r.policy ?? null,
                };
              })
              .sort(
                (a: any, b: any) =>
                  Number(b.buyAllowed) - Number(a.buyAllowed) ||
                  (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0),
              )
              .slice(0, 4),
            waiting: this.market
              .markets()
              .filter(
                (m: any) => this.market.isEntryCandidate(m.address) && m.quality !== 'verified',
              )
              .slice(0, 4)
              .map((m: any) => ({ symbol: m.symbol, reason: m.reason })),
          },
          lastRun: this.store.get('cloud-settings', 'scheduler'),
        });
      const response = await handleFetch(
        app,
        request,
        request.headers.get('CF-Connecting-IP') ?? 'local',
      );
      if (app.paper.orders().some((o: any) => o.status === 'queued')) await this.arm(1000);
      return response;
    } catch {
      return json({ error: '服务尚未完成配置或暂时不可用，请稍后重试' }, 503);
    }
  }
  async alarm() {
    return this.io.run('alarm', () => this.scheduledRound());
  }
  async scheduledRound() {
    return runScheduledRound(this);
  }
  async importLedger(request: Request) {
    if (
      request.method !== 'POST' ||
      !same(
        request.headers.get('Authorization') ?? '',
        'Bearer ' + (this.env.BI_TRADE_MIGRATION_TOKEN ?? ''),
      ) ||
      !this.env.BI_TRADE_MIGRATION_TOKEN
    )
      return json({ error: 'Not found' }, 404);
    const text = await request.text();
    if (Buffer.byteLength(text) > 5_000_000) return json({ error: 'Import too large' }, 413);
    const digest = createHash('sha256').update(text).digest('hex'),
      previous = this.store.get('cloud-settings', 'imported');
    if (previous)
      return previous.digest === digest
        ? json({ imported: true, entities: previous.entities })
        : json({ error: 'Import already completed' }, 409);
    if (this.importing) return json({ error: 'Import is already running' }, 409);
    const input = JSON.parse(text);
    if (
      input.version !== 1 ||
      !Array.isArray(input.entities) ||
      !Array.isArray(input.intents) ||
      !Array.isArray(input.audit)
    )
      return json({ error: 'Invalid snapshot' }, 400);
    const vault = new EncryptedVault(Buffer.from(this.env.BI_TRADE_VAULT_KEY, 'base64'));
    this.importing = true;
    try {
      await this.working;
      await this.decisionTask;
      const result = mergeLedger(this.store, vault, input, digest);
      this.app = null;
      this.market = null;
      this.risk = null;
      await this.arm();
      return json(result);
    } catch {
      return json({ error: 'Import conflicts with existing data or vault' }, 409);
    } finally {
      this.importing = false;
    }
  }
  async checkAI(request: Request) {
    if (
      request.method !== 'POST' ||
      !this.env.BI_TRADE_MIGRATION_TOKEN ||
      !same(
        request.headers.get('Authorization') ?? '',
        'Bearer ' + this.env.BI_TRADE_MIGRATION_TOKEN,
      )
    )
      return json({ error: 'Not found' }, 404);
    const app = await this.initialize(),
      config = app.showcase.configReader();
    if (!config) return json({ configured: false }, 409);
    const fingerprint = createHash('sha256')
        .update(JSON.stringify([config.baseUrl, config.model, config.apiKey, 90000]))
        .digest('hex'),
      previous = this.store.get('cloud-settings', 'ai-check');
    if (previous?.fingerprint === fingerprint)
      return json({
        ok: previous.ok,
        pending: previous.pending ?? false,
        model: config.model,
        reason: previous.reason,
      });
    this.store.put('cloud-settings', {
      id: 'ai-check',
      fingerprint,
      pending: true,
      at: Date.now(),
    });
    reserveAICall(this.store, config);
    try {
      const decision = await new OpenAIPlanner({ timeoutMs: 90000 }).decide(
        config,
        { description: '连接验证。当前没有候选市场和持仓，保持观察，只输出 hold。' },
        {
          at: Date.now(),
          chainId: 56,
          account: { initialUsd: 1000, balanceUsd: 1000, realizedUsd: 0, positions: [] },
          markets: [],
        },
      );
      if (decision.action !== 'hold') throw Error();
      const reason = 'Cloudflare AI API 连接及决策格式验证通过；测试未下单';
      this.store.put('cloud-settings', {
        id: 'ai-check',
        fingerprint,
        ok: true,
        at: Date.now(),
        reason,
      });
      return json({ ok: true, model: config.model, reason });
    } catch (e: any) {
      const reason = e.status ? e.message : '云端 AI API 验证失败';
      this.store.put('cloud-settings', {
        id: 'ai-check',
        fingerprint,
        ok: false,
        at: Date.now(),
        reason,
      });
      return json({ ok: false, model: config.model, reason }, 503);
    }
  }
}

export default {
  async scheduled(_controller: any, env: any, ctx: any) {
    if (env.BI_TRADE_ORIGIN_URL) return;
    const id = env.PLATFORM.idFromName('bitrade-platform-v1');
    ctx.waitUntil(
      env.PLATFORM.get(id)
        .fetch(new Request(env.SITE_ORIGIN + '/api/runtime'))
        .then((r: any) => r.arrayBuffer())
        .catch(() => {}),
    );
  },
  async fetch(request: Request, env: any) {
    const url = new URL(request.url),
      origin = new URL(env.SITE_ORIGIN).origin;
    if (url.origin !== origin) {
      if (
        ['GET', 'HEAD'].includes(request.method) &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/__admin/') &&
        url.pathname !== '/mcp'
      )
        return Response.redirect(origin + url.pathname + url.search, 308);
      return json({ error: '站点Host不匹配' }, 403);
    }
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname === '/mcp' ||
      url.pathname.startsWith('/__admin/')
    ) {
      if (env.BI_TRADE_ORIGIN_URL) {
        if (url.pathname.startsWith('/__admin/')) return json({ error: 'Not found' }, 404);
        if (!env.BI_TRADE_ORIGIN_PROXY_TOKEN)
          return json({ error: '服务暂时不可用，请稍后重试', code: 'ORIGIN_UNAVAILABLE' }, 503);
        try {
          const upstreamBase = new URL(env.BI_TRADE_ORIGIN_URL);
          if (
            upstreamBase.protocol !== 'https:' ||
            upstreamBase.hostname !== 'origin.bitrade.site' ||
            upstreamBase.username ||
            upstreamBase.password
          )
            return json({ error: '服务暂时不可用，请稍后重试', code: 'ORIGIN_UNAVAILABLE' }, 503);
          const upstream = new URL(url.pathname + url.search, upstreamBase);
          const headers = new Headers(request.headers);
          headers.delete('Host');
          headers.delete('X-BI-Proxy-Key');
          headers.delete('X-BI-Client-IP');
          headers.set('X-BI-Proxy-Key', env.BI_TRADE_ORIGIN_PROXY_TOKEN);
          const clientIp = request.headers.get('CF-Connecting-IP');
          if (clientIp && clientIp.length <= 64) headers.set('X-BI-Client-IP', clientIp);
          const response = await fetch(
            new Request(upstream, {
              method: request.method,
              headers,
              body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
              redirect: 'manual',
            } as any),
          );
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        } catch {
          return json({ error: '服务暂时不可用，请稍后重试', code: 'ORIGIN_UNAVAILABLE' }, 503);
        }
      }
      const id = env.PLATFORM.idFromName('bitrade-platform-v1');
      try {
        return await env.PLATFORM.get(id).fetch(request);
      } catch (e: any) {
        const quota = /Exceeded allowed rows (written|read) in Durable Objects free tier/.test(
          String(e?.message ?? ''),
        );
        const knownDeadline = Date.parse(env.BI_TRADE_STORAGE_READ_ONLY_UNTIL ?? '');
        // A quota error after the expected reset does not establish a new daily
        // allowance or recovery time. Keep retrying without promising tomorrow.
        const retryAt = quota && knownDeadline > Date.now() ? knownDeadline : null;
        const response = json(
          {
            error: quota
              ? '云端存储仍返回额度限制，暂时无法读取账户与成交。服务恢复后自动重试；不会重置资金或历史。'
              : '服务暂时不可用，请稍后重试',
            code: quota ? 'STORAGE_DAILY_QUOTA' : 'SERVICE_UNAVAILABLE',
            retryAt,
          },
          503,
        );
        if (quota)
          response.headers.set(
            'Retry-After',
            retryAt ? String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) : '300',
          );
        return response;
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: '不支持此请求方法' }, 405);
    const asset = ASSET_ROUTES[url.pathname];
    if (asset) url.pathname = '/' + asset;
    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY)) headers.set(k, v);
    headers.set('Cache-Control', asset ? 'no-cache' : 'public, max-age=3600');
    return new Response(response.body, { status: response.status, headers });
  },
};
