import { keccak256, parseAbi } from 'viem';
import { correctKnownLegacyCooldown, retryAfter } from './retry-after.mjs';
import {
  ESTABLISHED_ASSETS,
  establishedAsset,
  evaluateEstablishedRisk,
} from '../bi-trade/lib/established-risk.mjs';
const FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
  WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  DEAD = '0x000000000000000000000000000000000000dead';
const ABI = parseAbi([
  'function getPair(address,address) view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const HOSTS = { dex: 'https://api.dexscreener.com', safety: 'https://api.honeypot.is' };
export class PublicBscData {
  constructor(store, rpc, { fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    Object.assign(this, { store, rpc, fetch: fetchImpl, now });
    correctKnownLegacyCooldown(store, now());
    this.pending = new Map();
    this.queues = new Map();
  }
  supports(token) {
    return Boolean(establishedAsset(token));
  }
  candidates() {
    return ESTABLISHED_ASSETS;
  }
  status() {
    return Object.entries(HOSTS).map(([id]) => ({
      source: id === 'dex' ? 'DEX Screener' : 'Honeypot.is',
      ...this.store.get('cloud-settings', 'public-budget-' + id),
      limited: this.now() < (this.store.get('cloud-settings', 'public-budget-' + id)?.retryAt ?? 0),
    }));
  }
  async read(service, path) {
    const id = service + ':' + path,
      old = this.store.get('cloud-public-cache', id);
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 60000) return old;
    if (this.pending.has(id)) return this.pending.get(id);
    const task = (this.queues.get(service) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const budget = this.store.get('cloud-settings', 'public-budget-' + service) ?? {};
        if (this.now() < (budget.retryAt ?? 0)) throw Error('备用数据源冷却中，等待服务恢复');
        const delay = Math.max(0, (budget.lastAt ?? 0) + 2000 - this.now());
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const at = this.now();
        this.store.put('cloud-settings', { ...budget, id: 'public-budget-' + service, lastAt: at });
        try {
          const response = await this.fetch(HOSTS[service] + path, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(12000),
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            const receivedAt = this.now(),
              retry = retryAfter(response.headers.get('Retry-After'), receivedAt);
            this.store.put('cloud-settings', {
              ...budget,
              id: 'public-budget-' + service,
              lastAt: at,
              retryAt: Math.max(
                receivedAt + (response.status === 429 ? 300000 : 60000),
                retry.at === null ? 0 : retry.at + 5000,
              ),
              retryAfterVersion: 2,
              retryAfterKind: retry.kind,
              lastFailure: { at: receivedAt, status: response.status, serverRetryAt: retry.at },
              lastError: 'HTTP ' + response.status,
              lastSuccessAt: budget.lastSuccessAt ?? null,
            });
            throw Error('备用数据源暂不可用：HTTP ' + response.status);
          }
          const age = Number(response.headers.get('Age') ?? 0);
          if (Number.isFinite(age) && age > 120) throw Error('备用数据源响应已过期');
          const size = Number(response.headers.get('Content-Length') ?? 0);
          if (size > 2000000) throw Error('备用数据源响应过大');
          const text = await response.text();
          if (text.length > 2000000) throw Error('备用数据源响应过大');
          const value = JSON.parse(text);
          if (value.error || (value.code && ![0, 1, 200].includes(Number(value.code))))
            throw Error('备用数据源未返回有效资料');
          const row = { id, at: at - (Number.isFinite(age) && age > 0 ? age * 1000 : 0), value };
          this.store.put('cloud-public-cache', row);
          this.store.put('cloud-settings', {
            ...budget,
            id: 'public-budget-' + service,
            lastAt: at,
            lastSuccessAt: this.now(),
            retryAt: 0,
            lastError: null,
          });
          return row;
        } catch (e) {
          if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
          const current = this.store.get('cloud-settings', 'public-budget-' + service);
          if (!(current.retryAt > at))
            this.store.put('cloud-settings', {
              ...current,
              id: 'public-budget-' + service,
              retryAt: at + 60000,
              lastError: 'DATA_UNAVAILABLE',
            });
          throw e;
        }
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    this.queues.set(service, task);
    return task;
  }
  async evidence(token) {
    const asset = establishedAsset(token);
    if (!asset) throw Error('成熟外盘名单外的合约仍需完整的新币风控资料');
    const id = 'evidence:' + asset.address,
      old = this.store.get('cloud-public-cache', id);
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 60000) return old.value;
    if (this.pending.has(id)) return this.pending.get(id);
    const task = (async () => {
      const rows = await Promise.all([
        this.read('dex', '/latest/dex/pairs/bsc/' + asset.pool),
        this.read(
          'safety',
          '/v2/IsHoneypot?chainID=56&address=' + asset.address + '&pair=' + asset.pool,
        ),
      ]);
      const b = await this.rpc.block();
      const [pool, code, supply, burnBalance, poolBalance] = await Promise.all([
        this.rpc.read(FACTORY, ABI, 'getPair', [asset.address, WBNB], b.number),
        this.rpc.request('eth_getCode', [asset.address, '0x' + b.number.toString(16)]),
        this.rpc.read(asset.address, ABI, 'totalSupply', [], b.number),
        this.rpc.read(asset.address, ABI, 'balanceOf', [DEAD], b.number),
        this.rpc.read(asset.address, ABI, 'balanceOf', [asset.pool], b.number),
      ]);
      const pair = rows[0].value.pairs?.find((p) => p.pairAddress?.toLowerCase() === asset.pool);
      const value = {
        pair,
        check: rows[1].value,
        proof: {
          pool: String(pool).toLowerCase(),
          codeHash: keccak256(code),
          totalSupply: String(supply),
          burnBalance: String(burnBalance),
          poolBalance: String(poolBalance),
          block: b.number,
        },
        at: Math.min(...rows.map((r) => r.at)),
      };
      if (!pair) throw Error('官方池独立行情缺失');
      this.store.put('cloud-public-cache', { id, at: value.at, value });
      return value;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
  async riskReport(token) {
    const d = await this.evidence(token),
      holders = await this.read(
        'safety',
        '/v1/TopHolders?chainID=56&address=' + establishedAsset(token).address,
      );
    return evaluateEstablishedRisk(
      token,
      { ...d, holders: holders.value },
      Math.min(d.at, holders.at),
    );
  }
  async metadata(token) {
    const d = await this.evidence(token),
      report = evaluateEstablishedRisk(token, d, d.at);
    // Exit quotes need current trading evidence, independently of holder screening.
    // Missing holder evidence still blocks new entries through riskReport().
    const c = d.check,
      a = establishedAsset(token);
    if (
      d.pair.chainId !== 'bsc' ||
      d.pair.dexId !== 'pancakeswap' ||
      d.pair.baseToken?.address?.toLowerCase() !== a.address ||
      d.pair.quoteToken?.address?.toLowerCase() !== WBNB ||
      d.pair.pairAddress?.toLowerCase() !== a.pool ||
      String(c.chain?.id) !== '56' ||
      String(c.pair?.chainId) !== '56' ||
      c.token?.address?.toLowerCase() !== a.address ||
      c.pair?.pair?.address?.toLowerCase() !== a.pool ||
      c.simulationSuccess !== true ||
      c.contractCode?.isProxy !== false ||
      c.contractCode?.hasProxyCalls !== false ||
      c.contractCode?.openSource !== true ||
      c.contractCode?.rootOpenSource !== true ||
      report.metrics.honeypot !== false ||
      report.metrics.buyTaxPct !== 0 ||
      report.metrics.sellTaxPct !== 0 ||
      c.simulationResult?.transferTax !== 0 ||
      d.proof.codeHash !== a.codeHash ||
      d.proof.pool !== a.pool
    )
      throw Error('成熟外盘买卖税或身份尚未核实');
    return {
      id: token,
      at: d.at,
      source: 'public-bsc',
      info: {
        address: token,
        name: d.pair.baseToken.name,
        symbol: d.pair.baseToken.symbol,
        biggest_pool_address: d.pair.pairAddress,
        liquidity: d.pair.liquidity.usd,
        price: { price: d.pair.priceUsd, volume_24h: d.pair.volume?.h24 },
        priceChange: d.pair.priceChange,
        txns: d.pair.txns,
      },
      security: {
        address: token,
        buy_tax: 0,
        sell_tax: 0,
        is_honeypot: false,
        verifiedPool: establishedAsset(token).pool,
      },
    };
  }
}
