import { randomUUID } from 'node:crypto';
import { Venues } from '../paper-terminal/src/server/adapters/venues.js';
import { ReceiptGas } from '../paper-terminal/src/server/adapters/fees.js';
import { ERC20, FLAP_ABI } from '../paper-terminal/src/server/adapters/abi.js';
import {
  CHAIN_CONFIG,
  FLAP,
  ZERO,
  ORDINARY_RECIPIENT,
  address,
  RouteBlocked,
  capMap,
} from '../paper-terminal/src/server/adapters/types.js';
import {
  units,
  flapReserve,
  ceilDiv,
  feeExcludedImpact,
} from '../paper-terminal/src/server/adapters/math.js';
import { CloudRpc } from './rpc.mjs';
import { GmgnHTTP, unwrap } from './gmgn.mjs';
import { NativePrice } from './native-price.mjs';
import { establishedAsset } from '../bi-trade/lib/established-risk.mjs';
import { RISK_POLICY } from '../bi-trade/lib/token-risk-core.mjs';
import { activeFlapLaunches } from './flap-data.mjs';
import { marketRuntime } from './market-runtime.mjs';
const finite = (x: any) =>
  x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
const raw = (x: any) => {
  if (typeof x !== 'string' || !/^\d{1,78}$/.test(x) || BigInt(x) <= 0n)
    throw Error('报价金额无效');
  return BigInt(x);
};
const key = (_chain: string, token: string) => token.toLowerCase();
function flapCurveDepthUsd(state: any, quoteUsd: number) {
  try {
    const denominator =
      1000000000n * 10n ** 18n + BigInt(state.h) - BigInt(state.circulatingSupply);
    const depth = units(ceilDiv(BigInt(state.k) * 10n ** 18n, denominator), 18) * quoteUsd;
    return Number.isFinite(depth) && depth > 0 ? depth : null;
  } catch {
    return null;
  }
}
// Pricing samples may checkpoint once a minute. Eligibility, route identity,
// execution quality and taxes must become durable immediately when they change.
const MARKET_STATE_FIELDS = [
  'id',
  'address',
  'chain',
  'category',
  'symbol',
  'name',
  'decimals',
  'entryActive',
  'active',
  'entryRank',
  'platform',
  'stage',
  'venue',
  'quoteSymbol',
  'quoteProofMode',
  'buyTaxPct',
  'sellTaxPct',
  'createdAt',
  'discoveredAt',
  'discoverySource',
  'quality',
  'reason',
];

export class CloudMarket {
  rpc: any;
  gmgn: any;
  publicData: any;
  memeData: any;
  store: any;
  venues: any;
  gas: any;
  nativePrice: any;
  catalog = new Map<string, any>();
  metadata = new Map<string, any>();
  routes = new Map<string, any>();
  buyPreviews = new Map<string, any>();
  quoteRevision: any = { bsc: 0 };
  fxValue: any = null;
  fxPersistAt = 0;
  head: any = { chain: 'bsc', connected: false, head: 0, headAt: 0, chainTime: 0 };
  refreshTask: any = null;
  discoveryAt = 0;
  memeOnly = false;
  cursor = 0;
  pulseCursor = 0;
  explorationCursor = 0;
  runtime: any;
  persistAt = new Map<string, number>();
  gap: () => void;
  constructor(
    store: any,
    {
      rpc = new CloudRpc(),
      gmgn = new GmgnHTTP(null),
      publicData = null,
      memeData = null,
      memeOnly = false,
      runtime = marketRuntime(),
      onGap = () => {},
    }: any = {},
  ) {
    Object.assign(this, { store, rpc, gmgn, publicData, memeData, memeOnly, runtime, gap: onGap });
    this.venues = { bsc: new Venues(rpc) };
    this.gas = { bsc: new ReceiptGas(rpc) };
    this.nativePrice = new NativePrice(rpc);
    if (memeData?.flap) memeData.flap.market = this;
    for (const m of store.all('cloud-markets')) {
      this.catalog.set(m.address, m);
      if (Number.isFinite(m.updatedAt) && m.updatedAt > 0)
        this.persistAt.set(m.id ?? m.address, m.updatedAt);
    }
    for (const m of store.all('cloud-metadata')) this.metadata.set(m.id, m);
    this.fxValue = store.get('cloud-settings', 'native-fx');
    const fxAt = this.fxValue?.readAt ?? this.fxValue?.at;
    if (Number.isFinite(fxAt) && fxAt > 0) this.fxPersistAt = fxAt;
    this.discoveryAt = store.get('cloud-settings', 'discovery')?.at ?? 0;
    this.cursor = store.get('cloud-settings', 'market-cursor')?.next ?? 0;
    this.explorationCursor = store.get('cloud-settings', 'market-cursor')?.explorationNext ?? 0;
  }
  statuses() {
    return [
      {
        ...this.head,
        connected:
          this.head.connected &&
          Date.now() - this.head.headAt <= 15000 &&
          Math.abs(Date.now() - this.head.chainTime) <= 15000,
      },
    ];
  }
  prioritizedEntryMarkets() {
    const busy = activeFlapLaunches(this.memeData?.candidates() ?? [], Date.now()),
      rank = new Map(busy.map((m: any, i: number) => [m.address, i]));
    return this.markets()
      .filter((m: any) => this.isEntryCandidate(m.address))
      .sort(
        (a: any, b: any) =>
          (rank.get(a.address) ?? 100) - (rank.get(b.address) ?? 100) ||
          (a.entryRank ?? 100) - (b.entryRank ?? 100),
      );
  }
  markets() {
    return [...this.catalog.values()];
  }
  marketScope() {
    if (this.memeOnly)
      return {
        kind: 'meme',
        tokens: this.memeData?.candidates().map((c: any) => c.symbol) ?? [],
        policy: 'bsc-meme-paper-v1',
      };
    return this.publicData
      ? {
          kind: 'established',
          tokens: this.publicData.candidates().map((a: any) => a.symbol),
          policy: 'established-spot-v1',
        }
      : null;
  }
  nativeReference(chain = 'bsc') {
    return chain === 'bsc' ? this.fxValue : null;
  }
  getMarket(chain: string, token: string) {
    return chain === 'bsc' ? this.catalog.get(token.toLowerCase()) : null;
  }
  isEntryCandidate(token: string) {
    return (
      !this.memeOnly ||
      (!establishedAsset(token) &&
        this.catalog.get(token.toLowerCase())?.category === 'meme' &&
        this.catalog.get(token.toLowerCase())?.entryActive !== false)
    );
  }
  assertEntry(token: string) {
    if (!this.isEntryCandidate(token))
      throw Error('当前仅允许 BSC Meme 新开仓；原持仓继续核对退出。');
  }
  async updateHead() {
    const b = await this.rpc.block();
    if (this.head.head) {
      const old = await this.rpc.block(this.head.head, true);
      if (old.hash !== this.head.hash || b.number < this.head.head) {
        this.quoteRevision.bsc++;
        this.routes.clear();
        this.buyPreviews.clear();
        this.venues.bsc.invalidate();
        this.gas.bsc.invalidate(Math.min(b.number, this.head.head));
        this.gap();
      }
    }
    this.head = {
      chain: 'bsc',
      connected: Math.abs(Date.now() - b.time) <= 15000,
      head: b.number,
      headAt: Date.now(),
      chainTime: b.time,
      hash: b.hash,
      lastError: Math.abs(Date.now() - b.time) <= 15000 ? '' : 'BSC 链头时间已过期',
    };
    return b;
  }
  persistMarket(m: any) {
    const id = m.id ?? m.address,
      value = m.id ? m : { ...m, id },
      old = this.store.get('cloud-markets', id),
      at = Date.now(),
      savedAt = this.persistAt.get(id) ?? 0;
    if (
      !old ||
      MARKET_STATE_FIELDS.some((field) => old[field] !== value[field]) ||
      at < savedAt ||
      at - savedAt >= 60000
    ) {
      this.store.put('cloud-markets', value);
      this.persistAt.set(id, at);
      capMap(this.persistAt, 100);
    }
  }
  async fx() {
    if (
      this.fxValue &&
      Date.now() - this.fxValue.at >= 0 &&
      Date.now() - this.fxValue.at < 90000 &&
      Date.now() - (this.fxValue.readAt ?? this.fxValue.at) < 20000
    )
      return this.fxValue;
    try {
      this.fxValue = await this.nativePrice.read();
    } catch {
      // GMGN is a backup, not a prerequisite for the native USD reference.
      const response = await this.gmgn.info('bsc', CHAIN_CONFIG.bsc.wrapped),
        info = unwrap(response),
        usd = Number(info?.price?.price),
        at = response._bitradeReadAt ?? Date.now();
      if (!Number.isFinite(usd) || usd <= 0 || Date.now() - at < 0 || Date.now() - at >= 90000)
        throw Error('BNB 美元行情未核实');
      this.fxValue = { id: 'native-fx', usd, at, readAt: at, source: 'GMGN WBNB/USD' };
    }
    const old = this.store.get('cloud-settings', 'native-fx'),
      at = Date.now();
    if (
      !old ||
      old.source !== this.fxValue.source ||
      at < this.fxPersistAt ||
      at - this.fxPersistAt >= 60000
    ) {
      this.store.put('cloud-settings', this.fxValue);
      this.fxPersistAt = at;
    }
    return this.fxValue;
  }
  async loadMetadata(token: string) {
    const old = this.metadata.get(token);
    if (old && Date.now() - old.at >= 0 && Date.now() - old.at < 90000) return old;
    if (
      this.memeData?.flap?.quoteAsset(token) &&
      ![ZERO, CHAIN_CONFIG.bsc.wrapped].includes(token as any)
    ) {
      const next = await this.memeData.flap.quoteMetadata(token);
      this.metadata.set(token, next);
      this.store.put('cloud-metadata', next);
      return next;
    }
    if (this.memeData?.supports(token)) {
      const next = await this.memeData.metadata(token);
      this.metadata.set(token, next);
      this.store.put('cloud-metadata', next);
      return next;
    }
    if (this.publicData?.supports(token)) {
      const next = await this.publicData.metadata(token);
      this.metadata.set(token, next);
      this.store.put('cloud-metadata', next);
      return next;
    }
    const responses = [await this.gmgn.info('bsc', token), await this.gmgn.security('bsc', token)],
      [info, security] = responses.map(unwrap);
    if (address(info.address) !== token || address(security.address) !== token)
      throw Error('行情资料的合约地址不匹配');
    const at = Math.min(Date.now(), ...responses.map((r) => r._bitradeReadAt ?? Date.now()));
    const next = { id: token, at, info, security };
    this.metadata.set(token, next);
    this.store.put('cloud-metadata', next);
    return next;
  }
  async route(chain: string, token: string, block: number) {
    const old = this.routes.get(token);
    if (
      old &&
      ['v2', 'v3'].includes(old.route.kind) &&
      old.route.state?.platform !== 'flap' &&
      block >= old.block
    )
      return old.route;
    if (old?.route.state?.platform === 'flap' && old.block === block) return old.route;
    if (old?.route.state?.platform === 'flap' && ['v2', 'v3'].includes(old.route.kind)) {
      const s = await this.rpc.read(FLAP, FLAP_ABI, 'getTokenV8Safe', [address(token)], block);
      if (
        Number(s.status) === 4 &&
        address(s.pool) === old.route.pool &&
        address(s.quoteTokenAddress) === old.route.quote
      ) {
        const route = { ...old.route, state: { ...s, platform: 'flap' } };
        this.routes.set(token, { block, route });
        return route;
      }
    }
    const md = await this.loadMetadata(token),
      hint = md.info.biggest_pool_address;
    const revision = this.quoteRevision.bsc,
      route = ['public-bsc', 'meme-bsc'].includes(md.source)
        ? await this.venues.bsc.pool(
            address(token),
            address(CHAIN_CONFIG.bsc.wrapped),
            address(hint),
            block,
          )
        : await this.venues.bsc.resolve(address(token), block, hint);
    if (revision !== this.quoteRevision.bsc) throw Error('核价期间发生区块重组');
    this.routes.set(token, { block, route });
    capMap(this.routes, 100);
    return route;
  }
  verifyExternalTaxes(chain: string, token: string, r: any) {
    if (!['v2', 'v3'].includes(r.kind) || r.state?.platform) return;
    const md = this.metadata.get(key(chain, token));
    if (!md || Date.now() - md.at > 120000)
      throw new RouteBlocked('TAX_UNKNOWN', '外盘代币安全及转账税字段尚未核实');
    const s = md.security,
      buy = finite(s.buy_tax),
      sell = finite(s.sell_tax);
    if (['public-bsc', 'meme-bsc', 'flap-quote'].includes(md.source) && s.verifiedPool !== r.pool)
      throw new RouteBlocked('TAX_UNKNOWN', '买卖税检测与当前池不一致');
    if (buy === null || sell === null) throw new RouteBlocked('TAX_UNKNOWN', '外盘买卖税字段缺失');
    if (buy !== 0 || sell !== 0)
      throw new RouteBlocked(
        'TRANSFER_TAX_UNVERIFIED',
        '该外盘币有转账税，需要进一步验证真实转账路线',
      );
    if (
      s.is_honeypot === 'yes' ||
      s.is_honeypot === true ||
      s.is_honeypot === 1 ||
      s.is_honeypot === '1'
    )
      throw new RouteBlocked('SELL_BLOCKED', '安全数据报告无法卖出');
  }
  async refreshMarket(token: string) {
    let m = this.catalog.get(token) ?? {
      id: token,
      address: token,
      chain: 'bsc',
      symbol: token.slice(0, 10),
      quality: 'unavailable',
      updatedAt: 0,
    };
    try {
      const md = await this.loadMetadata(token),
        fx = await this.fx(),
        b = await this.updateHead(),
        r = await this.route('bsc', token, b.number),
        v = this.venues.bsc;
      const decimals = await v.decimals(address(token), b.number),
        qDecimals = await v.decimals(r.quote, b.number),
        spot = await v.spot(r, b.number),
        conversion = await v.conversion(r.quote, b.number);
      let quoteUsd = fx.usd;
      if (conversion) {
        await this.loadMetadata(conversion.token);
        this.verifyExternalTaxes('bsc', conversion.token, conversion);
        const cv = await v.quote(
          conversion,
          'sell',
          10n ** BigInt(qDecimals),
          b.number,
          ORDINARY_RECIPIENT,
        );
        quoteUsd = units(cv.out, 18) * fx.usd;
      }
      const priceUsd = spot * 10 ** (decimals - qDecimals) * quoteUsd;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw Error('链上价格未核实');
      this.verifyExternalTaxes('bsc', token, r);
      if (
        ['v2', 'v3'].includes(r.kind) &&
        r.state?.platform !== 'flap' &&
        (BigInt(r.state?.buyTaxRate || 0) || BigInt(r.state?.sellTaxRate || 0))
      )
        throw Error('外盘转账税清算尚未核实');
      const statsAt =
          ['public-bsc', 'meme-bsc'].includes(md.source) && Object.hasOwn(md, 'marketDataAt')
            ? md.marketDataAt
            : md.at,
        statsFresh =
          Number.isFinite(statsAt) && Date.now() - statsAt >= 0 && Date.now() - statsAt < 120000,
        curveDepth = r.kind === 'flap' ? flapCurveDepthUsd(r.state, quoteUsd) : null;
      m = {
        ...m,
        decimals,
        symbol: String(md.info.symbol ?? m.symbol).slice(0, 60),
        name: String(md.info.name ?? m.symbol).slice(0, 100),
        venue: r.kind,
        platform: r.state?.platform ?? r.kind,
        stage: ['flap', 'four'].includes(r.kind) ? 'curve' : 'dex',
        priceUsd,
        nativeUsd: fx.usd,
        quoteUsd,
        quoteProofMode: conversion
          ? (this.metadata.get(conversion.token)?.security.proofMode ?? null)
          : null,
        quoteSymbol:
          md.flap?.quoteSymbol ??
          (conversion ? this.metadata.get(conversion.token)?.info.symbol : 'BNB'),
        progressPct:
          r.state?.platform === 'flap' || r.kind === 'flap'
            ? Number(r.state?.progress) / 1e16
            : null,
        createdAt: md.flap?.createdAt ?? m.createdAt ?? null,
        reserveUsd:
          r.kind === 'flap' ? units(BigInt(r.state!.reserve), qDecimals) * quoteUsd : null,
        // Curve depth includes the virtual term used by the Portal invariant.
        // It is a model input, not real funds or an executable-size guarantee.
        curveVirtualReserveUsd: curveDepth,
        curveDepthQuality: curveDepth === null ? null : 'curve-model-estimate',
        liquidityUsd:
          md.source === 'flap-bsc'
            ? r.kind === 'flap'
              ? units(BigInt(r.state!.reserve), qDecimals) * quoteUsd
              : units(
                  BigInt(
                    await this.rpc.read(
                      r.quote === ZERO ? address(CHAIN_CONFIG.bsc.wrapped) : r.quote,
                      ERC20,
                      'balanceOf',
                      [r.pool],
                      b.number,
                    ),
                  ),
                  qDecimals,
                ) * quoteUsd
            : statsFresh
              ? finite(md.info.liquidity)
              : null,
        volumeUsd: statsFresh ? finite(md.info.price?.volume_24h) : null,
        buyTaxPct: Number(r.state?.buyTaxRate ?? 0) / 100,
        sellTaxPct: Number(r.state?.sellTaxRate ?? 0) / 100,
        dataSource:
          md.source === 'flap-bsc'
            ? 'Flap Portal · BSC RPC · actual quote conversion'
            : md.source === 'meme-bsc'
              ? 'BSC RPC · Four.meme / Flap · ' +
                (md.info.chartSource ?? 'independent pool data') +
                ' · Honeypot.is'
              : md.source === 'public-bsc'
                ? statsFresh
                  ? 'BSC RPC · DEX Screener · Honeypot.is'
                  : 'BSC RPC · Honeypot.is'
                : 'BSC RPC · GMGN',
        marketDataAt: statsFresh ? statsAt : null,
        priceChange: statsFresh ? (md.info.priceChange ?? null) : null,
        transactions: statsFresh ? (md.info.txns ?? null) : null,
        volumeWindow: statsFresh ? (md.info.volumeWindow ?? null) : null,
        updatedAt: Date.now(),
        block: b.number,
        quality: 'verified',
        reason: '固定区块链上价格与路线已核实，成交另行核价',
      };
    } catch (e: any) {
      m = { ...m, quality: 'unavailable', reason: String(e.message).slice(0, 260) };
    }
    this.catalog.set(token, m);
    this.persistMarket(m);
    return m;
  }
  async discover() {
    if (this.memeOnly && this.memeData) {
      const candidates = await this.memeData.discover(),
        active = new Set(candidates.map((c: any) => c.address));
      for (const candidate of candidates) {
        const old = this.catalog.get(candidate.address);
        const m = {
          ...old,
          ...candidate,
          category: 'meme',
          chain: 'bsc',
          quality: old?.quality ?? 'unavailable',
          updatedAt: old?.updatedAt ?? 0,
          discoveredAt: old?.discoveredAt ?? candidate.at,
          entryActive: true,
        };
        this.catalog.set(m.address, m);
        this.persistMarket(m);
      }
      for (const [token, m] of this.catalog)
        if (m.category === 'meme' && !active.has(token)) {
          const next = { ...m, entryActive: false };
          this.catalog.set(token, next);
          this.persistMarket(next);
        }
      const held = new Set(
        this.store
          .all('paper-lots')
          .filter((l: any) => BigInt(l.remainingRaw) > 0n)
          .map((l: any) => l.token),
      );
      for (const [token, m] of this.catalog)
        if (!active.has(token) && !held.has(token) && !this.publicData?.supports(token)) {
          this.catalog.delete(token);
          this.metadata.delete(token);
          this.routes.delete(token);
          for (const kind of ['cloud-markets', 'cloud-metadata'])
            this.store.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, token);
        }
      return;
    }
    // Keep a narrow, independently verified mature-asset universe available
    // even while the meme-token provider is cooling down.
    for (const item of (this.memeOnly ? [] : this.publicData?.candidates()) ?? []) {
      if (!this.catalog.has(item.address)) {
        const m = {
          id: item.address,
          address: item.address,
          chain: 'bsc',
          symbol: item.symbol,
          quality: 'unavailable',
          updatedAt: 0,
          discoveredAt: Date.now(),
        };
        this.catalog.set(item.address, m);
        this.persistMarket(m);
      }
    }
    if (this.gmgn.status?.().limited) return;
    if (Date.now() - this.discoveryAt < 300000 && this.catalog.size) return;
    const data = unwrap(await this.gmgn.trenches());
    this.discoveryAt = Date.now();
    this.store.put('cloud-settings', { id: 'discovery', at: this.discoveryAt });
    for (const rows of Object.values(data ?? {})) {
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (
          (item.chain && item.chain !== 'bsc') ||
          !/^0x[a-f0-9]{40}$/i.test(item.address) ||
          !/flap|four[._-]?meme|pool_pancake/i.test(item.launchpad_platform ?? '')
        )
          continue;
        if (this.memeOnly && !/flap|four[._-]?meme/i.test(item.launchpad_platform ?? '')) continue;
        const token = item.address.toLowerCase();
        if (!this.catalog.has(token)) {
          const m = {
            id: token,
            address: token,
            chain: 'bsc',
            symbol: String(item.symbol ?? token.slice(0, 10)).slice(0, 60),
            category: 'meme',
            quality: 'unavailable',
            updatedAt: 0,
            discoveredAt: Date.now(),
          };
          this.catalog.set(token, m);
          this.persistMarket(m);
        }
      }
    }
    const held = new Set(
      this.store
        .all('paper-lots')
        .filter((l: any) => BigInt(l.remainingRaw) > 0n)
        .map((l: any) => l.token),
    );
    for (const [token] of this.catalog) {
      if (this.catalog.size <= 12) break;
      if (!held.has(token) && !this.publicData?.supports(token)) {
        this.catalog.delete(token);
        this.metadata.delete(token);
        this.routes.delete(token);
        this.store.db
          .prepare('DELETE FROM entities WHERE kind=? AND id=?')
          .run('cloud-markets', token);
        this.store.db
          .prepare('DELETE FROM entities WHERE kind=? AND id=?')
          .run('cloud-metadata', token);
      }
    }
  }
  refresh(tokens: string[] = [], { limit = 2, onlyRequested = false }: any = {}) {
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = (async () => {
      try {
        await this.updateHead();
      } catch (e: any) {
        this.head.connected = false;
        this.head.lastError = String(e.message).slice(0, 260);
        return;
      }
      try {
        await this.fx();
      } catch {
        /* An unavailable USD feed does not disconnect the chain. */
      }
      if (this.gmgn.status?.().limited && !this.publicData && !this.memeData) return;
      if (!onlyRequested) {
        try {
          await this.discover();
        } catch {
          /* Continue updating already discovered markets when discovery is unavailable. */
        }
      }
      if (this.gmgn.status?.().limited && !this.publicData && !this.memeData) return;
      try {
        const candidates = [...this.catalog.keys()].filter((token) => this.isEntryCandidate(token)),
          pool = [...new Set([...tokens, ...candidates])],
          selected = [
            ...new Set(
              onlyRequested
                ? tokens
                : limit === 1
                  ? [pool[this.cursor % pool.length]].filter(Boolean)
                  : [...tokens, ...candidates.slice(this.cursor, this.cursor + limit)],
            ),
          ].slice(0, 8);
        if (this.runtime.selfHosted && !onlyRequested) {
          const ranked = this.memeData?.candidates() ?? [],
            busy = activeFlapLaunches(ranked, Date.now())[0]?.address,
            priority = [...new Set([...tokens, ...(busy ? [busy] : [])])],
            exploration = pool.filter((t) => !priority.includes(t)),
            // Held positions and a busy launch can fill the nominal batch.
            // Keep one real exploration read ahead of held refreshes rather
            // than leaving every other entry stale indefinitely. Exit checks
            // have their own priority round and retain exact fresh quotes.
            count = Math.max(exploration.length ? 1 : 0, limit - priority.length),
            rotated = Array.from(
              { length: Math.min(count, exploration.length) },
              (_, i) => exploration[(this.explorationCursor + i) % exploration.length],
            );
          selected.splice(
            0,
            selected.length,
            ...[...new Set([...(busy ? [busy] : []), ...rotated, ...tokens])].slice(0, 8),
          );
          this.explorationCursor = exploration.length
            ? (this.explorationCursor + rotated.length) % exploration.length
            : 0;
        }
        this.cursor = pool.length ? (this.cursor + limit) % pool.length : 0;
        const started = Date.now();
        for (let i = 0; i < selected.length; i += this.runtime.refreshConcurrency)
          await Promise.all(
            selected
              .slice(i, i + this.runtime.refreshConcurrency)
              .map((token) => this.refreshMarket(token)),
          );
        await this.updateHead();
        if (this.memeOnly)
          this.store.put('cloud-settings', {
            id: 'market-cursor',
            next: this.cursor,
            ...(this.runtime.selfHosted
              ? {
                  explorationNext: this.explorationCursor,
                  refreshMs: Date.now() - started,
                  lastBatch: selected.map((token) => ({
                    token,
                    updatedAt: this.catalog.get(token)?.updatedAt ?? null,
                    quality: this.catalog.get(token)?.quality ?? 'unavailable',
                  })),
                }
              : {}),
          });
      } catch (e: any) {
        // Chain connectivity is reported by RPC, independently of token data.
      }
    })().finally(() => {
      this.refreshTask = null;
    });
    return this.refreshTask;
  }
  marketReason() {
    if (this.memeOnly) return '正在核对 BSC Meme 候选、交易池和风险资料，合格后继续模拟评估。';
    if (this.publicData) return '正在核对成熟外盘的独立行情与买卖检测，取得有效数据后自动继续。';
    return this.gmgn.status?.().limited
      ? '行情服务限频冷却中，候选币与风控资料暂不可用；恢复后自动继续。'
      : '等待取得合格候选市场';
  }
  marketWait() {
    const rpc = this.rpc.status?.();
    if (rpc?.limited) return { retryAt: rpc.retryAt };
    if (this.memeData || this.publicData) {
      const waits = (this.memeData ?? this.publicData)
        .status()
        .filter((s: any) => s.limited)
        .map((s: any) => s.retryAt);
      return waits.length ? { retryAt: Math.max(...waits) } : null;
    }
    const status = this.gmgn.status?.();
    return status?.limited ? { retryAt: status.retryAt } : null;
  }
  async pulse(limit = 2) {
    const b = await this.updateHead(),
      fx = this.fxValue;
    if (!fx || Date.now() - fx.at < 0 || Date.now() - fx.at >= 90000) return;
    // No GMGN I/O here: keep the chain and already collected markets fresh while
    // risk collection or model inference is waiting on a slower remote service.
    const entries = this.markets().filter((m: any) => this.metadata.has(m.address));
    const eligible = this.memeOnly
      ? entries.filter((m: any) => {
          const r = this.store.get('token-risk-reports', m.address);
          return (
            this.isEntryCandidate(m.address) &&
            ['bsc-meme-paper-v1', 'bsc-flap-paper-v1'].includes(r?.policy) &&
            r.buyAllowed === true &&
            Number.isFinite(r.fetchedAt) &&
            Date.now() - r.fetchedAt >= 0 &&
            Date.now() - r.fetchedAt <= RISK_POLICY.maxAgeMs
          );
        })
      : [];
    const pool = eligible.length ? eligible : entries;
    const selected = Array.from(
      { length: Math.min(limit, pool.length) },
      (_, i) => pool[(this.pulseCursor + i) % pool.length],
    );
    this.pulseCursor = pool.length ? (this.pulseCursor + limit) % pool.length : 0;
    for (const m of selected) {
      try {
        const md = this.metadata.get(m.address);
        if (md.source === 'flap-bsc') {
          await this.refreshMarket(m.address);
          continue;
        }
        if (Date.now() - md.at >= 120000) continue;
        if (['public-bsc', 'meme-bsc'].includes(md.source) && !this.routes.has(m.address)) continue;
        const v = this.venues.bsc,
          cached = this.routes.get(m.address),
          r =
            cached &&
            ['v2', 'v3'].includes(cached.route.kind) &&
            cached.route.state?.platform !== 'flap'
              ? cached.route
              : await v.resolve(address(m.address), b.number, md.info.biggest_pool_address);
        const qd = await v.decimals(r.quote, b.number),
          td = await v.decimals(address(m.address), b.number),
          spot = await v.spot(r, b.number),
          conversion = await v.conversion(r.quote, b.number);
        let usd = fx.usd;
        if (conversion) {
          this.verifyExternalTaxes('bsc', conversion.token, conversion);
          const cv = await v.quote(
            conversion,
            'sell',
            10n ** BigInt(qd),
            b.number,
            ORDINARY_RECIPIENT,
          );
          usd = units(cv.out, 18) * fx.usd;
        }
        this.verifyExternalTaxes('bsc', m.address, r);
        if (
          ['v2', 'v3'].includes(r.kind) &&
          r.state?.platform !== 'flap' &&
          (BigInt(r.state?.buyTaxRate || 0) || BigInt(r.state?.sellTaxRate || 0))
        )
          continue;
        const priceUsd = spot * 10 ** (td - qd) * usd;
        if (!Number.isFinite(priceUsd) || priceUsd <= 0 || Date.now() - b.time > 15000) continue;
        const statsFresh =
          Number.isFinite(m.marketDataAt) &&
          Date.now() - m.marketDataAt >= 0 &&
          Date.now() - m.marketDataAt < 120000;
        const next = {
          ...m,
          ...(['public-bsc', 'meme-bsc'].includes(md.source) && !statsFresh
            ? {
                liquidityUsd: null,
                volumeUsd: null,
                priceChange: null,
                transactions: null,
                marketDataAt: null,
                volumeWindow: null,
                dataSource: 'BSC RPC · Honeypot.is',
              }
            : {}),
          priceUsd,
          nativeUsd: fx.usd,
          updatedAt: Date.now(),
          block: b.number,
          quality: 'verified',
        };
        this.catalog.set(m.address, next);
        this.persistMarket(next);
      } catch {
        /* Failed reads never refresh a market timestamp. */
      }
    }
  }
  async quote(request: any) {
    if (request.chain !== 'bsc' || !['buy', 'sell'].includes(request.side))
      throw Error('不支持的报价请求');
    const token = address(request.token),
      recipient = address(request.recipient);
    if (recipient === ZERO) throw Error('报价须使用独立账户地址');
    const revision = this.quoteRevision.bsc,
      b = await this.updateHead(),
      block = request.block ?? b.number;
    if (
      !Number.isSafeInteger(block) ||
      block < 0 ||
      block > b.number ||
      !this.statuses()[0].connected
    )
      throw Error('BSC 区块或链头未核实');
    const exact = await this.rpc.block(block);
    if (b.time - exact.time > 15000) throw Error('报价区块已过期');
    const r = await this.route('bsc', token, block);
    await this.loadMetadata(token);
    const conversion = await this.venues.bsc.conversion(r.quote, block);
    if (conversion) await this.loadMetadata(conversion.token);
    const result = await this.quoteInternal(
      { ...request, token, recipient, block },
      await this.fx(),
    );
    const fresh = await this.updateHead();
    if (
      revision !== this.quoteRevision.bsc ||
      !this.statuses()[0].connected ||
      fresh.time - exact.time > 15000
    )
      throw Error('读取期间区块重组或报价已过期');
    return result;
  }
  stop() {}
  private async quoteInternal(request: any, fx: any, gasContext?: any): Promise<any> {
    const { chain, side } = request,
      revision = this.quoteRevision[chain],
      block = request.block!,
      token = address(request.token),
      recipient = address(request.recipient),
      input = raw(side === 'buy' ? request.nativeAmountRaw : request.tokenAmountRaw);
    let r = await this.route(chain, token, block);
    this.verifyExternalTaxes(chain, token, r);
    const previewKey = key(chain, token) + ':' + recipient;
    const preview = this.buyPreviews.get(previewKey);
    let counterfactual = false;
    if (
      side === 'sell' &&
      r.kind === 'flap' &&
      preview?.block === block &&
      preview.output === input
    ) {
      r = preview.route;
      counterfactual = true;
    }
    const v = this.venues[chain],
      decimals = await v.decimals(token, block),
      quoteDecimals = await v.decimals(r.quote, block),
      conversion = await v.conversion(r.quote, block);
    if (conversion) this.verifyExternalTaxes(chain, conversion.token, conversion);
    let quoteInput = input,
      conversionUsd = 0,
      conversionSpot = 1,
      legs = 1,
      notes: string[] = [],
      conversionImpact = 0;
    let simulatedTransfer = false;
    const checkConversionTransfers = async (amount: bigint) => {
      if (
        conversion &&
        this.metadata.get(conversion.token)?.security.proofMode === 'rpc-sequential-transfers'
      ) {
        const proof = await this.memeData.flap.quoteTransfers(
          conversion.token,
          conversion.pool,
          amount,
          block,
          recipient,
        );
        simulatedTransfer = true;
        notes.push(
          `报价资产按确切数量和模拟收款地址完成兑换池 ↔ 账户 ↔ Flap Portal 四段零税到账核对；来源区块 ${proof.parentBlock}，假设的下一块 ${proof.simulatedBlock}，未验证真实资金、签名、授权或整笔 swap`,
        );
      }
    };
    if (conversion) {
      legs++;
      const unit = await v.quote(conversion, 'sell', 10n ** BigInt(quoteDecimals), block);
      conversionSpot = unit.spot * 10 ** (quoteDecimals - 18);
      if (!(conversionSpot > 0))
        throw new RouteBlocked('CONVERSION_UNKNOWN', '报价币兑原生币路线无流动性');
      if (side === 'buy') {
        const cv = await v.quote(conversion, 'buy', input, block, recipient);
        quoteInput = cv.out;
        await checkConversionTransfers(cv.out);
        conversionUsd = units(cv.protocol, 18) * fx.usd;
        conversionImpact += cv.impactPct ?? feeExcludedImpact(conversion, 'buy', cv);
        notes.push(...cv.notes);
      }
    }
    const core = await v.quote(r, side, quoteInput, block, recipient);
    let output = core.out,
      spent = core.spent,
      refund = core.refund;
    if (side === 'buy' && r.kind === 'flap') {
      const s = r.state!,
        cs = {
          reserve: s.reserve,
          supply: s.circulatingSupply,
          r: s.r,
          h: s.h,
          k: s.k,
          threshold: s.dexSupplyThresh,
          quoteDecimals,
          feeBps: BigInt(s.buyFeeBps),
          taxBps: BigInt(s.buyTaxRate),
        };
      const nextSupply = BigInt(s.circulatingSupply) + core.out;
      if (nextSupply >= BigInt(s.dexSupplyThresh))
        throw new RouteBlocked(
          'FLAP_GRADUATION_TRANSITION',
          '本次虚拟买入会触发毕业，尚不能核实同一复合交易的新池与退款',
        );
      this.buyPreviews.set(previewKey, {
        block,
        output: core.out,
        route: {
          ...r,
          state: {
            ...s,
            circulatingSupply: nextSupply,
            reserve: flapReserve(cs, nextSupply),
            price:
              (BigInt(s.k) * 10n ** 36n) /
              (1000000000n * 10n ** 18n + BigInt(s.h) - nextSupply) ** 2n,
            virtualPreview: true,
          },
        },
      });
      capMap(this.buyPreviews, 1000);
    }
    if (conversion) {
      const quoteUsd = conversionSpot * fx.usd;
      if (side === 'sell') {
        await checkConversionTransfers(core.out);
        const cv = await v.quote(conversion, 'sell', core.out, block, recipient);
        output = cv.out;
        spent = input;
        refund = 0n;
        conversionUsd = units(cv.protocol, 18) * fx.usd;
        conversionImpact += cv.impactPct ?? feeExcludedImpact(conversion, 'sell', cv);
        notes.push(...cv.notes);
      } else {
        spent = input;
        refund = 0n;
        if (core.refund > 0n)
          throw new RouteBlocked(
            'PARTIAL_CONVERSION_UNVERIFIED',
            '跨报价币的部分成交需在转换后的池状态退款；该复合路线尚未逐步核实，拒绝虚构原生币退款',
          );
      }
      notes.push(
        `报价币精度 ${quoteDecimals}；已核实池 ${conversion.pool}，美元换算使用实际原生币价格`,
      );
    }
    if (output <= 0n || spent <= 0n || spent > input || refund < 0n)
      throw new RouteBlocked('ZERO_QUOTE', '报价返回零数量或不合法金额');
    const gas = await this.gas[chain].estimate(r, block, side, fx.usd, legs, gasContext);
    const quoteUsd = (conversion ? conversionSpot : 1) * fx.usd;
    if (revision !== this.quoteRevision[chain])
      throw new RouteBlocked('QUOTE_REORG', '报价期间发生区块重组，请重新报价');
    const tokenQty = units(side === 'buy' ? output : input, decimals),
      nativeQty = units(side === 'buy' ? spent : output, 18),
      priceUsd = (nativeQty * fx.usd) / tokenQty;
    const impactPct = (core.impactPct ?? feeExcludedImpact(r, side, core)) + conversionImpact,
      impactQuality =
        core.impactQuality === 'estimated' || counterfactual || simulatedTransfer
          ? 'estimated'
          : 'verified';
    return {
      id: randomUUID(),
      chain,
      token,
      side,
      block,
      at: Date.now(),
      sourceFeeFrozenAt: gas.sourceFeeFrozenAt,
      inputRaw: input.toString(),
      outputRaw: output.toString(),
      spentInputRaw: spent.toString(),
      refundRaw: refund.toString(),
      tokenDecimals: decimals,
      nativeUsd: fx.usd,
      priceUsd,
      priceImpactPct: impactPct,
      impactQuality,
      fees: {
        gasUsd: gas.gasUsd,
        approvalUsd: gas.approvalUsd,
        protocolUsd: units(core.protocol, quoteDecimals) * quoteUsd,
        taxUsd: units(core.tax, quoteDecimals) * quoteUsd,
        conversionUsd,
        includedInOutput: true,
        quality: 'estimated',
        notes: [
          ...core.notes,
          ...notes,
          ...gas.notes,
          `流动性冲击排除已知协议/创作者/反狙击费；多步兑换冲击保守相加，归因 ${impactQuality}`,
          `原生币美元价格：${fx.source ?? '已核实美元参考'} ${new Date(fx.at).toISOString()}；模拟收款地址 ${recipient}，不继承目标钱包豁免`,
        ],
      },
      quality:
        counterfactual || core.quality === 'estimated' || simulatedTransfer
          ? 'estimated'
          : 'verified',
      venue: r.kind,
      reason: simulatedTransfer
        ? '确切金额的链上报价与下一块报价资产连续转账模拟；不保证真实资金、签名、授权或整笔 swap'
        : core.quality === 'estimated'
          ? 'Flap 含税外盘官方净报价；未执行真实授权和转账，成交为估计模拟'
          : counterfactual
            ? '虚拟买入后即时反向数量预览；不可用于正式研究启用门槛'
            : '按固定区块和确切金额的链上报价；Gas 与费用美元归因估计，费用已含在报价内',
    };
  }
}
