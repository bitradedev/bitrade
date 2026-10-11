import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual, createHash } from 'node:crypto';
import { CloudStore } from './store.mjs';
import { EncryptedVault } from '../bi-trade/lib/vault-core.mjs';
import { createPlatformCore } from '../bi-trade/platform-core.mjs';
import { TokenRiskGuard } from '../bi-trade/lib/token-risk-core.mjs';
import { OpenAIPlanner, validateConfig, reserveAICall } from '../bi-trade/lib/ai-provider.mjs';
import { CloudMarket } from './market.js';
import { CloudRpc } from './rpc.mjs';
import { GmgnHTTP } from './gmgn.mjs';
import { marketFetch } from './market-source.mjs';
import { PublicBscData } from './public-data.mjs';
import { IOBudget } from './io-budget.mjs';
import { handleFetch } from './bridge.mjs';
import { mergeLedger } from './import.mjs';

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
  importing = false;
  constructor(ctx: any, env: any) {
    super(ctx, env);
    this.store = new CloudStore(ctx.storage);
    this.io = new IOBudget(45);
  }
  initialize() {
    if (this.app) return Promise.resolve(this.app);
    if (this.initializing) return this.initializing;
    this.initializing = this.ctx
      .blockConcurrencyWhile(async () => {
        if (!this.env.BI_TRADE_VAULT_KEY) throw Error('Missing vault secret');
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
            fetchImpl: this.io.fetch,
          }),
          publicData =
            this.env.BI_TRADE_PUBLIC_MARKET === 'true'
              ? new PublicBscData(this.store, rpc, { fetchImpl: this.io.fetch })
              : null,
          market = new CloudMarket(this.store, {
            rpc,
            gmgn: source,
            publicData,
            onGap: () => this.app?.paper.gap(),
          });
        const risk = new TokenRiskGuard(this.store, {
            maxTokensPerTick: 1,
            source: {
              label: (token: string) =>
                publicData?.supports(token) ? 'BSC RPC · DEX Screener · Honeypot.is' : 'GMGN API',
              riskReport: (token: string) =>
                publicData?.supports(token) ? publicData.riskReport(token) : null,
              info: (...args: any[]) => source.info(...args),
              holders: (...args: any[]) => source.holders(...args),
              security: (...args: any[]) => source.security(...args),
              close: () => source.close(),
            },
          }),
          planner = new OpenAIPlanner({ timeoutMs: 90000, fetchImpl: this.io.fetch });
        // Refresh exact market evidence after the remote model returns; it may take over a minute.
        const freshPlanner = {
          decide: async (...args: any[]) => {
            const decision = await planner.decide(...args);
            await market.refresh(decision.token ? [decision.token] : [], {
              limit: 1,
              onlyRequested: true,
            });
            return decision;
          },
        };
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
          liveEnabled: false,
          rpc: { balance: async () => 0n },
          rateLimit: (...args: any[]) => this.store.rateLimit(...args),
          showcaseOptions: { configReader, planner: freshPlanner, maxAgentsPerRun: 1 },
          assetReader: async (name: string) =>
            Buffer.from(
              await (
                await this.env.ASSETS.fetch(new Request(this.env.SITE_ORIGIN + '/' + name))
              ).arrayBuffer(),
            ),
        });
        this.app.paper.maxOrdersPerTick = 1;
        for (const a of this.store.all('agents').filter((a: any) => a.source === 'builtin')) {
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
  async arm(delay = 10000) {
    const next = await this.ctx.storage.getAlarm();
    if (next === null || next > Date.now() + delay)
      await this.ctx.storage.setAlarm(Date.now() + delay);
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
      const app = await this.initialize();
      await this.arm();
      if (url.pathname === '/api/runtime')
        return json({
          platform: 'cloudflare',
          liveEnabled: false,
          aiConfigured: !!this.env.BI_TRADE_AI_API_KEY,
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
          publicMarketSources: this.market.publicData?.status() ?? [],
          networkBudget: this.io.lastAlarm,
          marketRetryAt: this.store.get('cloud-settings', 'gmgn-budget')?.cooldown ?? null,
          marketRetryReason: this.store.get('cloud-settings', 'gmgn-budget')?.errorCode ?? null,
          candidates: {
            known: this.market.markets().length,
            verified: this.market.markets().filter((m: any) => m.quality === 'verified').length,
            fresh: app.showcase.freshMarkets().length,
            waiting: this.market
              .markets()
              .filter((m: any) => m.quality !== 'verified')
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
    // Save the following alarm first. Failures or isolate eviction cannot stop scheduling.
    await this.ctx.storage.setAlarm(Date.now() + 10000);
    if (this.importing) return;
    if (this.working) return this.working;
    this.working = (async () => {
      try {
        const app = await this.initialize();
        if (app.paper.orders().some((o: any) => o.status === 'queued')) {
          // Matching gets its own invocation budget instead of sharing model I/O.
          await this.market.updateHead();
          await this.market.fx();
          await app.paper.tick();
          this.store.put('cloud-settings', {
            id: 'scheduler',
            at: Date.now(),
            ok: true,
            phase: 'matching',
          });
          return;
        }
        const tokens = [
          ...new Set(
            this.store
              .all('paper-lots')
              .filter((l: any) => BigInt(l.remainingRaw) > 0n)
              .map((l: any) => l.token),
          ),
        ] as string[];
        await this.market.refresh(tokens, { limit: 1 });
        await app.paper.tick();
        await this.risk.tick([
          ...tokens,
          ...app.showcase.freshMarkets().map((m: any) => m.address),
        ]);
        await this.market.pulse(1);
        await app.showcase.tick();
        await this.risk.task;
        // New orders are matched on the next alarm, with a fresh I/O budget.
        this.store.prune();
        this.store.put('cloud-settings', { id: 'scheduler', at: Date.now(), ok: true });
      } catch {
        this.store.put('cloud-settings', {
          id: 'scheduler',
          at: Date.now(),
          ok: false,
          reason: '本轮行情或模拟调度未完成，将自动重试',
        });
      } finally {
        this.working = null;
        await this.arm(
          this.app?.paper.orders().some((o: any) => o.status === 'queued') ? 1000 : 10000,
        );
      }
    })();
    return this.working;
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
      const id = env.PLATFORM.idFromName('bitrade-platform-v1');
      return env.PLATFORM.get(id).fetch(request);
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
