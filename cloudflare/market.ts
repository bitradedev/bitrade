import { randomUUID } from 'node:crypto';
import { Venues } from '../paper-terminal/src/server/adapters/venues.js';
import { ReceiptGas } from '../paper-terminal/src/server/adapters/fees.js';
import {
  CHAIN_CONFIG,
  ZERO,
  ORDINARY_RECIPIENT,
  address,
  RouteBlocked,
  capMap,
} from '../paper-terminal/src/server/adapters/types.js';
import {
  units,
  flapReserve,
  feeExcludedImpact,
} from '../paper-terminal/src/server/adapters/math.js';
import { CloudRpc } from './rpc.mjs';
import { GmgnHTTP, unwrap } from './gmgn.mjs';
import { NativePrice } from './native-price.mjs';
const finite = (x: any) =>
  x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
const raw = (x: any) => {
  if (typeof x !== 'string' || !/^\d{1,78}$/.test(x) || BigInt(x) <= 0n)
    throw Error('报价金额无效');
  return BigInt(x);
};
const key = (_chain: string, token: string) => token.toLowerCase();

export class CloudMarket {
  rpc: any;
  gmgn: any;
  publicData: any;
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
  head: any = { chain: 'bsc', connected: false, head: 0, headAt: 0, chainTime: 0 };
  refreshTask: any = null;
  discoveryAt = 0;
  cursor = 0;
  pulseCursor = 0;
  persistAt = new Map<string, number>();
  gap: () => void;
  constructor(
    store: any,
    {
      rpc = new CloudRpc(),
      gmgn = new GmgnHTTP(null),
      publicData = null,
      onGap = () => {},
    }: any = {},
  ) {
    Object.assign(this, { store, rpc, gmgn, publicData, gap: onGap });
    this.venues = { bsc: new Venues(rpc) };
    this.gas = { bsc: new ReceiptGas(rpc) };
    this.nativePrice = new NativePrice(rpc);
    for (const m of store.all('cloud-markets')) this.catalog.set(m.address, m);
    for (const m of store.all('cloud-metadata')) this.metadata.set(m.id, m);
    this.fxValue = store.get('cloud-settings', 'native-fx');
    this.discoveryAt = store.get('cloud-settings', 'discovery')?.at ?? 0;
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
  markets() {
    return [...this.catalog.values()];
  }
  marketScope() {
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
    this.store.put('cloud-settings', this.fxValue);
    return this.fxValue;
  }
  async loadMetadata(token: string) {
    const old = this.metadata.get(token);
    if (old && Date.now() - old.at >= 0 && Date.now() - old.at < 90000) return old;
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
    if (old && ['v2', 'v3'].includes(old.route.kind) && block >= old.block) return old.route;
    const md = await this.loadMetadata(token),
      hint = md.info.biggest_pool_address;
    const revision = this.quoteRevision.bsc,
      route =
        md.source === 'public-bsc'
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
    if (md.source === 'public-bsc' && s.verifiedPool !== r.pool)
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
        (BigInt(r.state?.buyTaxRate || 0) || BigInt(r.state?.sellTaxRate || 0))
      )
        throw Error('外盘转账税清算尚未核实');
      const statsAt =
          md.source === 'public-bsc' && Object.hasOwn(md, 'marketDataAt') ? md.marketDataAt : md.at,
        statsFresh =
          Number.isFinite(statsAt) && Date.now() - statsAt >= 0 && Date.now() - statsAt < 120000;
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
        liquidityUsd: statsFresh ? finite(md.info.liquidity) : null,
        volumeUsd: statsFresh ? finite(md.info.price?.volume_24h) : null,
        buyTaxPct: Number(r.state?.buyTaxRate ?? 0) / 100,
        sellTaxPct: Number(r.state?.sellTaxRate ?? 0) / 100,
        dataSource:
          md.source === 'public-bsc'
            ? statsFresh
              ? 'BSC RPC · DEX Screener · Honeypot.is'
              : 'BSC RPC · Honeypot.is'
            : 'BSC RPC · GMGN',
        marketDataAt: statsFresh ? statsAt : null,
        priceChange: statsFresh ? (md.info.priceChange ?? null) : null,
        transactions: statsFresh ? (md.info.txns ?? null) : null,
        updatedAt: Date.now(),
        block: b.number,
        quality: 'verified',
        reason: '固定区块链上价格与路线已核实，成交另行核价',
      };
    } catch (e: any) {
      m = { ...m, quality: 'unavailable', reason: String(e.message).slice(0, 260) };
    }
    this.catalog.set(token, m);
    this.store.put('cloud-markets', m);
    return m;
  }
  async discover() {
    // Keep a narrow, independently verified mature-asset universe available
    // even while the meme-token provider is cooling down.
    for (const item of this.publicData?.candidates() ?? []) {
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
        this.store.put('cloud-markets', m);
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
        const token = item.address.toLowerCase();
        if (!this.catalog.has(token)) {
          const m = {
            id: token,
            address: token,
            chain: 'bsc',
            symbol: String(item.symbol ?? token.slice(0, 10)).slice(0, 60),
            quality: 'unavailable',
            updatedAt: 0,
            discoveredAt: Date.now(),
          };
          this.catalog.set(token, m);
          this.store.put('cloud-markets', m);
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
      if (this.gmgn.status?.().limited && !this.publicData) return;
      try {
        await this.discover();
      } catch {
        /* Continue updating already discovered markets when discovery is unavailable. */
      }
      if (this.gmgn.status?.().limited && !this.publicData) return;
      try {
        const candidates = [...this.catalog.keys()],
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
        this.cursor = pool.length ? (this.cursor + limit) % pool.length : 0;
        for (const token of selected) await this.refreshMarket(token);
        await this.updateHead();
      } catch (e: any) {
        // Chain connectivity is reported by RPC, independently of token data.
      }
    })().finally(() => {
      this.refreshTask = null;
    });
    return this.refreshTask;
  }
  marketReason() {
    if (this.publicData) return '正在核对成熟外盘的独立行情与买卖检测，取得有效数据后自动继续。';
    return this.gmgn.status?.().limited
      ? '行情服务限频冷却中，候选币与风控资料暂不可用；恢复后自动继续。'
      : '等待取得合格候选市场';
  }
  marketWait() {
    const rpc = this.rpc.status?.();
    if (rpc?.limited) return { retryAt: rpc.retryAt };
    if (this.publicData) {
      const waits = this.publicData
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
    const selected = entries.slice(this.pulseCursor, this.pulseCursor + limit);
    this.pulseCursor = entries.length ? (this.pulseCursor + limit) % entries.length : 0;
    for (const m of selected) {
      try {
        const md = this.metadata.get(m.address);
        if (Date.now() - md.at >= 120000) continue;
        if (md.source === 'public-bsc' && !this.routes.has(m.address)) continue;
        const v = this.venues.bsc,
          cached = this.routes.get(m.address),
          r =
            cached && ['v2', 'v3'].includes(cached.route.kind)
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
          ...(md.source === 'public-bsc' && !statsFresh
            ? {
                liquidityUsd: null,
                volumeUsd: null,
                priceChange: null,
                transactions: null,
                marketDataAt: null,
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
        if (Date.now() - (this.persistAt.get(m.address) ?? 0) > 15000) {
          this.store.put('cloud-markets', next);
          this.persistAt.set(m.address, Date.now());
        }
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
      BigInt(r.state!.circulatingSupply) < input &&
      preview?.block === block &&
      preview.output >= input
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
    if (conversion) {
      legs++;
      const unit = await v.quote(conversion, 'sell', 10n ** BigInt(quoteDecimals), block);
      conversionSpot = unit.spot * 10 ** (quoteDecimals - 18);
      if (!(conversionSpot > 0))
        throw new RouteBlocked('CONVERSION_UNKNOWN', '报价币兑原生币路线无流动性');
      if (side === 'buy') {
        const cv = await v.quote(conversion, 'buy', input, block, recipient);
        quoteInput = cv.out;
        conversionUsd = units(cv.protocol, 18) * fx.usd;
        conversionImpact += cv.impactPct ?? feeExcludedImpact(conversion, 'buy', cv);
        notes.push(...cv.notes);
      }
    }
    const core = await v.quote(r, side, quoteInput, block, recipient);
    let output = core.out,
      spent = core.spent,
      refund = core.refund;
    if (side === 'buy' && r.kind === 'flap' && !conversion) {
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
      this.buyPreviews.set(previewKey, {
        block,
        output: core.out,
        route: {
          ...r,
          state: {
            ...s,
            circulatingSupply: nextSupply,
            reserve: flapReserve(cs, nextSupply),
            virtualPreview: true,
          },
        },
      });
      capMap(this.buyPreviews, 1000);
    }
    if (conversion) {
      const quoteUsd = conversionSpot * fx.usd;
      if (side === 'sell') {
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
        core.impactQuality === 'estimated' || counterfactual ? 'estimated' : 'verified';
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
      quality: counterfactual ? 'estimated' : 'verified',
      venue: r.kind,
      reason: counterfactual
        ? '虚拟买入后即时反向数量预览；不可用于正式研究启用门槛'
        : '按固定区块和确切金额的链上报价；Gas 与费用美元归因估计，费用已含在报价内',
    };
  }
}
