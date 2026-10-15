import { parseAbi, decodeEventLog, getEventSelector, keccak256 } from 'viem';
import {
  FLAP,
  ZERO,
  CHAIN_CONFIG,
  ORDINARY_RECIPIENT,
} from '../paper-terminal/src/server/adapters/types.js';
import { FLAP_ABI, ERC20 } from '../paper-terminal/src/server/adapters/abi.js';
import { evaluateFlapRisk } from '../bi-trade/lib/flap-risk.mjs';
import { probeQuoteTransfers } from './quote-transfers.mjs';

export const FLAP_EVENTS = parseAbi([
  'event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta)',
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
]);
export const FLAP_QUOTES = Object.freeze({
  [ZERO]: 'BNB',
  [CHAIN_CONFIG.bsc.wrapped]: 'WBNB',
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD1',
});
const TRANSFERS = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'function totalSupply() view returns (uint256)',
]);
const lower = (v) =>
  typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null;
const hex = (n) => '0x' + n.toString(16);
const hash = (v) => /^0x[0-9a-f]{64}$/i.test(v ?? '');
const json = (v) =>
  JSON.parse(
    JSON.stringify(v, (_k, value) => (typeof value === 'bigint' ? value.toString() : value)),
  );
export function activeFlapLaunches(rows, now) {
  return rows
    .filter(
      (r) =>
        Number.isFinite(r.sampleAt) &&
        now >= r.sampleAt &&
        now - r.sampleAt < 120000 &&
        Number.isSafeInteger(r.sample?.buys) &&
        r.sample.buys > 0 &&
        Number.isSafeInteger(r.sample?.sells) &&
        r.sample.sells > 0,
    )
    .sort((a, b) => b.sample.buys + b.sample.sells - a.sample.buys - a.sample.sells);
}
function event(log, from, to) {
  if (log.removed) return null;
  if (
    lower(log.address) !== FLAP ||
    !hash(log.blockHash) ||
    !hash(log.transactionHash) ||
    !/^0x[0-9a-f]{1,12}$/i.test(log.blockNumber ?? '') ||
    !/^0x[0-9a-f]{1,12}$/i.test(log.logIndex ?? '')
  )
    throw Error('Flap 事件身份未核实');
  const block = Number(BigInt(log.blockNumber));
  if (block < from || block > to) throw Error('Flap 事件超出请求范围');
  return {
    ...decodeEventLog({ abi: FLAP_EVENTS, data: log.data, topics: log.topics, strict: true }),
    block,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
  };
}
export function flapCreations(logs, from, to, at) {
  if (!Array.isArray(logs) || logs.length > 4000) throw Error('Flap 发行事件过大');
  const seen = new Set(),
    rows = [];
  for (const log of logs) {
    const e = event(log, from, to);
    if (!e) continue;
    const key = e.blockHash + e.transactionHash + e.logIndex;
    if (seen.has(key)) throw Error('Flap 发行事件重复');
    seen.add(key);
    if (e.eventName !== 'TokenCreated') throw Error('发行事件类型不匹配');
    const token = lower(e.args.token),
      createdAt = Number(e.args.ts) * 1000;
    if (
      !token ||
      token === ZERO ||
      !lower(e.args.creator) ||
      !Number.isSafeInteger(createdAt) ||
      createdAt > at + 15000
    )
      throw Error('Flap 发行字段无效');
    rows.push({
      id: token,
      address: token,
      category: 'meme',
      platform: 'flap',
      label: 'Flap',
      symbol: String(e.args.symbol).slice(0, 60),
      name: String(e.args.name).slice(0, 100),
      at,
      discoverySource: 'Flap Portal · TokenCreated · BSC RPC',
      createdAt,
      creation: {
        block: e.block,
        blockHash: e.blockHash,
        transactionHash: e.transactionHash,
        logIndex: e.logIndex,
        creator: lower(e.args.creator),
      },
    });
  }
  return rows.sort((a, b) => b.creation.block - a.creation.block);
}
export function flapTurnover(logs, token, from, to) {
  return (
    flapTradeSamples(logs, from, to).get(token) ?? {
      quoteRaw: '0',
      buys: 0,
      sells: 0,
      fromBlock: from,
      toBlock: to,
    }
  );
}
function flapTradeSamples(logs, from, to) {
  if (!Array.isArray(logs) || logs.length > 4000) throw Error('Flap 成交样本过大');
  const samples = new Map();
  const seen = new Set();
  for (const log of logs) {
    const e = event(log, from, to);
    if (!e) continue;
    const key = e.blockHash + e.transactionHash + e.logIndex;
    if (seen.has(key)) throw Error('Flap 成交事件重复');
    seen.add(key);
    if (!['TokenBought', 'TokenSold'].includes(e.eventName)) throw Error('成交事件类型不匹配');
    const token = lower(e.args.token),
      s = samples.get(token) ?? { quoteRaw: 0n, buys: 0, sells: 0, fromBlock: from, toBlock: to };
    s.quoteRaw += e.args.eth;
    if (e.eventName === 'TokenBought') s.buys++;
    else s.sells++;
    samples.set(token, s);
  }
  return new Map(
    [...samples].map(([token, sample]) => [
      token,
      { ...sample, quoteRaw: sample.quoteRaw.toString() },
    ]),
  );
}
export function flapHolders(logs, token, from, to, supply, circulating) {
  if (!Array.isArray(logs) || logs.length > 4000) throw Error('Flap 持仓样本过大');
  const balances = new Map(),
    groups = new Map(),
    seen = new Set();
  for (const l of logs) {
    if (l.removed) continue;
    if (
      lower(l.address) !== token ||
      !hash(l.blockHash) ||
      !hash(l.transactionHash) ||
      !/^0x[0-9a-f]{1,12}$/i.test(l.blockNumber ?? '') ||
      !/^0x[0-9a-f]{1,12}$/i.test(l.logIndex ?? '') ||
      Number(BigInt(l.blockNumber)) < from ||
      Number(BigInt(l.blockNumber)) > to
    )
      throw Error('Flap 转账事件身份无效');
    const key = l.blockHash + l.transactionHash + l.logIndex;
    if (seen.has(key)) throw Error('Flap 转账事件重复');
    seen.add(key);
    const { args } = decodeEventLog({
      abi: TRANSFERS,
      data: l.data,
      topics: l.topics,
      strict: true,
    });
    const a = lower(args.from),
      b = lower(args.to);
    if (a !== ZERO) balances.set(a, (balances.get(a) ?? 0n) - args.value);
    if (b !== ZERO) balances.set(b, (balances.get(b) ?? 0n) + args.value);
    const g = groups.get(l.transactionHash) ?? new Set();
    g.add(b);
    groups.set(l.transactionHash, g);
  }
  if (
    [...balances.values()].some((n) => n < 0n) ||
    [...balances.values()].reduce((a, b) => a + b, 0n) !== BigInt(supply)
  )
    throw Error('Flap 转账历史与总供应量不一致');
  const excluded = new Set([ZERO, FLAP, token, '0x000000000000000000000000000000000000dead']);
  const normal = [...balances]
    .filter(([a, n]) => !excluded.has(a) && n > 0n)
    .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
  const largestShare = Number(normal[0]?.[1] ?? 0n) / Number(supply),
    topTenShare = Number(normal.slice(0, 10).reduce((n, h) => n + h[1], 0n)) / Number(supply);
  const clusters = [...groups]
    .map(([tx, wallets]) => ({
      tx,
      wallets: [...wallets].filter((a) => !excluded.has(a) && (balances.get(a) ?? 0n) > 0n),
    }))
    .filter((g) => g.wallets.length > 1)
    .map((g) => ({
      ...g,
      circulatingShare:
        Number(g.wallets.reduce((n, a) => n + balances.get(a), 0n)) / Number(circulating),
    }));
  return {
    available: true,
    fromBlock: from,
    toBlock: to,
    holderCount: normal.length,
    largestSupplyShare: largestShare,
    topTenSupplyShare: topTenShare,
    clusters,
  };
}

// Shared Portal index and fixed-block evidence. No private keys or transaction
// submission; discovery hints never grant execution permission.
export class FlapBscData {
  constructor(store, rpc, reader, { now = Date.now } = {}) {
    Object.assign(this, { store, rpc, reader, now });
    this.market = null;
  }
  supports(token) {
    const c = this.store.get('cloud-meme-candidates', token);
    return (
      c?.platform === 'flap' ||
      c?.discoverySource?.startsWith('Flap Portal') ||
      this.store.get('cloud-flap-evidence', token)?.originVerified === true
    );
  }
  quoteAsset(token) {
    return (
      Boolean(FLAP_QUOTES[token]) ||
      this.store.all('cloud-flap-evidence').some((e) => lower(e.state?.quoteTokenAddress) === token)
    );
  }
  status() {
    const rpc = this.rpc.statusFor?.('eth_getLogs') ?? {};
    return {
      source: 'Flap Portal · new launches',
      ...this.store.get('cloud-settings', 'flap-index'),
      limited: rpc.limited ?? false,
      retryAt: rpc.retryAt ?? 0,
    };
  }
  async discover() {
    const old = this.store.get('cloud-settings', 'flap-index');
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 120000)
      return this.rankedLaunches();
    try {
      const head = await this.rpc.block(),
        to = Math.max(0, head.number - 4),
        from = Math.max(0, to - 1999);
      const logs = await this.rpc.request('eth_getLogs', [
        {
          address: FLAP,
          fromBlock: hex(from),
          toBlock: hex(to),
          topics: [getEventSelector(FLAP_EVENTS[0])],
        },
      ]);
      if (!Array.isArray(logs) || logs.length > 4000) throw Error('Flap 事件样本过大');
      const rows = flapCreations(logs, from, to, this.now());
      let sampleError = null,
        samples = null;
      try {
        const sampleFrom = Math.max(0, to - 199),
          trades = await this.rpc.request('eth_getLogs', [
            {
              address: FLAP,
              fromBlock: hex(sampleFrom),
              toBlock: hex(to),
              topics: [[getEventSelector(FLAP_EVENTS[1]), getEventSelector(FLAP_EVENTS[2])]],
            },
          ]);
        samples = flapTradeSamples(trades, sampleFrom, to);
      } catch (e) {
        if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
        sampleError = '近期曲线成交样本暂未取得';
      }
      // Bound SQLite writes as well as network requests. Do not rewrite the
      // entire overlapping creation window on every minute's discovery.
      const active = rows
        .filter((r) => samples?.get(r.address)?.buys > 0 && samples?.get(r.address)?.sells > 0)
        .sort(
          (a, b) =>
            samples.get(b.address).buys +
            samples.get(b.address).sells -
            (samples.get(a.address).buys + samples.get(a.address).sells),
        )
        .slice(0, 3);
      const selected = [...new Map([...active, ...rows].map((r) => [r.id, r])).values()].slice(
        0,
        6,
      );
      const existing = this.store
        .all('cloud-meme-candidates')
        .filter((c) => c.platform === 'flap')
        .slice(0, 2)
        .map((c) => this.store.get('cloud-flap-launches', c.id))
        .filter(Boolean);
      for (const row of [...new Map([...selected, ...existing].map((r) => [r.id, r])).values()]) {
        const previous = this.store.get('cloud-flap-launches', row.id),
          same = previous?.creation?.blockHash === row.creation.blockHash;
        const sample = samples?.get(row.address);
        if (same && !sample) continue;
        this.store.put('cloud-flap-launches', {
          ...(same ? previous : row),
          ...(sample ? { sample, sampleAt: this.now() } : {}),
        });
      }
      const recent = this.store
        .all('cloud-flap-launches')
        .sort((a, b) => b.createdAt - a.createdAt);
      for (const row of recent.slice(48))
        this.store.db
          .prepare('DELETE FROM entities WHERE kind=? AND id=?')
          .run('cloud-flap-launches', row.id);
      this.store.put('cloud-settings', {
        id: 'flap-index',
        at: this.now(),
        fromBlock: from,
        toBlock: to,
        count: rows.length,
        indexedCount: selected.length,
        lastSuccessAt: this.now(),
        lastError: null,
        sampleError,
      });
      // Mix genuinely active launches with the newest arrivals. Samples are
      // quote-denominated and explicitly bounded, never invented 24h volume.
      return this.rankedLaunches();
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      this.store.put('cloud-settings', {
        ...old,
        id: 'flap-index',
        at: this.now(),
        lastError: 'Flap 新币发行事件暂未取得',
      });
      return this.rankedLaunches();
    }
  }
  rankedLaunches() {
    const rows = this.store.all('cloud-flap-launches').sort((a, b) => b.createdAt - a.createdAt);
    const active = activeFlapLaunches(rows, this.now());
    const mixed = [];
    for (let i = 0; i < 24; i++) {
      if (active[i]) mixed.push(active[i]);
      if (rows[i]) mixed.push(rows[i]);
    }
    return [...new Map(mixed.map((r) => [r.id, r])).values()].slice(0, 24);
  }
  async evidence(token) {
    const old = this.store.get('cloud-flap-evidence', token);
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 30000) return old;
    const block = await this.rpc.block(),
      candidate =
        this.store.get('cloud-flap-launches', token) ??
        this.store.get('cloud-meme-candidates', token);
    const [state, code, decimals] = await Promise.all([
      this.rpc.read(FLAP, FLAP_ABI, 'getTokenV8Safe', [token], block.number),
      this.rpc.request('eth_getCode', [token, hex(block.number)]),
      this.rpc.read(token, ERC20, 'decimals', [], block.number),
    ]);
    if (!code || code === '0x' || Number(state.status) === 0)
      throw Error('Flap 发行身份或代币代码未核实');
    if (candidate?.creation) {
      const b = await this.rpc.block(candidate.creation.block);
      if (b.hash.toLowerCase() !== candidate.creation.blockHash)
        throw Error('Flap 发行事件已发生链重组');
    }
    const codeHash = keccak256(code);
    if (old?.codeHash && old.codeHash !== codeHash)
      throw Error('Flap 代币代码发生变化，等待重新核查');
    const fee = await this.rpc.read(FLAP, FLAP_ABI, 'getFeeRate', [], block.number);
    const value = {
      id: token,
      token,
      at: this.now(),
      block: block.number,
      blockHash: block.hash,
      codeHash,
      originVerified: true,
      decimals: Number(decimals),
      state: json(state),
      buyFeeBps: String(fee[0]),
      sellFeeBps: String(fee[1]),
      candidate,
    };
    this.store.put('cloud-flap-evidence', value);
    return value;
  }
  async quoteMetadata(token) {
    if (!this.quoteAsset(token) || [ZERO, CHAIN_CONFIG.bsc.wrapped].includes(token))
      throw Error('报价资产未接入');
    const route = await this.market.venues.bsc.conversion(token, this.market.head.head);
    if (!route?.pool) throw Error('报价资产兑 BNB 交易池未核实');
    let check = null;
    try {
      check = await this.reader.read(
        'safety',
        '/v2/IsHoneypot?chainID=56&address=' + token + '&pair=' + route.pool,
      );
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
    }
    const c = check?.value,
      taxes = ['buyTax', 'sellTax', 'transferTax'],
      taxNumber = (v) =>
        (typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v))
          ? Number(v)
          : null;
    if (
      c?.honeypotResult?.isHoneypot === true ||
      taxes.some((k) => taxNumber(c?.simulationResult?.[k]) > 0) ||
      Number(c?.summary?.riskLevel) >= 20 ||
      c?.summary?.flags?.some((f) => Number(f.severityIndex) >= 10)
    )
      throw Error('报价资产已发现貔貅、非零税或明显安全风险');
    if (
      (c?.chain?.id != null && String(c.chain.id) !== '56') ||
      (c?.pair?.chainId != null && String(c.pair.chainId) !== '56') ||
      (c?.token?.address && lower(c.token.address) !== token) ||
      (c?.pair?.pair?.address && lower(c.pair.pair.address) !== route.pool)
    )
      throw Error('报价资产安全资料与当前资产或交易池不一致');
    const checked = !(
      String(c?.chain?.id) !== '56' ||
      lower(c?.token?.address) !== token ||
      lower(c?.pair?.pair?.address) !== route.pool ||
      c?.simulationSuccess !== true ||
      c?.honeypotResult?.isHoneypot !== false ||
      taxes.some((k) => taxNumber(c?.simulationResult?.[k]) !== 0)
    );
    let proof = null;
    if (!checked) {
      const block = this.market.head.head,
        decimals = await this.market.venues.bsc.decimals(token, block),
        balance = BigInt(await this.rpc.read(token, ERC20, 'balanceOf', [route.pool], block)),
        unit = 10n ** BigInt(decimals),
        sample = balance / 1000n;
      if (sample <= 0n) throw Error('报价资产兑换池没有足够真实余额用于转账检测');
      proof = await this.quoteTransfers(
        token,
        route.pool,
        sample < unit ? sample : unit,
        block,
        ORDINARY_RECIPIENT,
      );
    }
    const symbol =
      FLAP_QUOTES[token] ??
      String(await this.rpc.read(token, ERC20, 'symbol', [], this.market.head.head)).slice(0, 60);
    return {
      id: token,
      at: proof?.at ?? check.at,
      source: 'flap-quote',
      info: { address: token, symbol, biggest_pool_address: route.pool },
      security: {
        address: token,
        buy_tax: 0,
        sell_tax: 0,
        verifiedPool: route.pool,
        is_honeypot: proof ? null : false,
        proofMode: proof ? 'rpc-sequential-transfers' : 'honeypot-simulation',
        transferProof: proof,
      },
    };
  }
  async quoteTransfers(token, pool, amount, block, recipient) {
    const parent = await this.rpc.block(block),
      key = [token, pool, amount.toString(), recipient, parent.hash].join(':');
    this.transferProofs ??= new Map();
    const old = this.transferProofs.get(key);
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 15000) return old;
    const proof = await probeQuoteTransfers(this.rpc, {
      token,
      pool,
      recipient,
      amountRaw: String(amount),
      block,
    });
    this.transferProofs.set(key, proof);
    while (this.transferProofs.size > 256)
      this.transferProofs.delete(this.transferProofs.keys().next().value);
    return proof;
  }
  async metadata(token) {
    const e = await this.evidence(token),
      s = e.state,
      quote = lower(s.quoteTokenAddress);
    if (!quote) throw Error('Flap 报价资产地址无效');
    if (![1, 4].includes(Number(s.status))) throw Error('Flap 当前阶段不可买卖：' + s.status);
    if (!/^0x0{64}$/i.test(s.extensionID)) throw Error('Flap 扩展合约尚未核实，暂不能模拟成交');
    if (e.decimals !== 18) throw Error('Flap 曲线代币精度尚未支持');
    return {
      id: token,
      at: e.at,
      source: 'flap-bsc',
      marketDataAt: e.candidate?.sampleAt ?? null,
      flap: {
        ...s,
        block: e.block,
        originVerified: true,
        quoteSymbol: FLAP_QUOTES[quote],
        createdAt: e.candidate?.createdAt ?? null,
      },
      info: {
        address: token,
        symbol: e.candidate?.symbol ?? 'Flap',
        name: e.candidate?.name ?? 'Flap',
        biggest_pool_address: Number(s.status) === 4 ? lower(s.pool) : null,
        liquidity: null,
        price: {},
        chartSource: 'Flap Portal',
        txns: e.candidate?.sample
          ? { sample: { buys: e.candidate.sample.buys, sells: e.candidate.sample.sells } }
          : null,
        volumeWindow: e.candidate?.sample
          ? {
              fromBlock: e.candidate.sample.fromBlock,
              toBlock: e.candidate.sample.toBlock,
              quoteRaw: e.candidate.sample.quoteRaw,
              quoteSymbol: FLAP_QUOTES[quote],
              at: e.candidate.sampleAt,
            }
          : null,
      },
      security: {
        address: token,
        buy_tax: Number(s.buyTaxRate) / 100,
        sell_tax: Number(s.sellTaxRate) / 100,
        is_honeypot: null,
        verifiedPool: Number(s.status) === 4 ? lower(s.pool) : null,
      },
    };
  }
  async riskReport(token) {
    const e = await this.evidence(token),
      m = await this.market.refreshMarket(token);
    const currentRoute = this.market.routes.get(token)?.route;
    const block = await this.rpc.block(),
      s =
        currentRoute?.state &&
        (currentRoute.kind === 'flap' || currentRoute.state.platform === 'flap')
          ? currentRoute.state
          : e.state,
      quote = lower(s.quoteTokenAddress);
    let sellQuote = null;
    if (Number(s.status) === 1 && BigInt(s.circulatingSupply) > 0n && this.quoteAsset(quote)) {
      const amount = BigInt(s.circulatingSupply) / 1000n;
      if (amount > 0n)
        sellQuote = await this.rpc.read(
          FLAP,
          FLAP_ABI,
          'quoteExactInput',
          [{ inputToken: token, outputToken: quote, inputAmount: amount }],
          block.number,
          ORDINARY_RECIPIENT,
        );
    }
    if (Number(s.status) === 4 && m.quality === 'verified') {
      const route = await this.market.route('bsc', token, block.number);
      sellQuote = (
        await this.market.venues.bsc.quote(
          route,
          'sell',
          10n ** 18n,
          block.number,
          ORDINARY_RECIPIENT,
        )
      ).out;
    }
    // A quote tests the Portal's curve, not allowance or a user's balance.
    // Never turn absent holder/security tags into passing clean labels.
    const qd = await this.market.venues.bsc.decimals(quote, block.number),
      quoteUsd = m.quoteUsd ?? m.nativeUsd,
      reserveUsd =
        Number(s.status) === 4 ? m.liquidityUsd : (Number(s.reserve) / 10 ** qd) * quoteUsd;
    let holders = { available: false };
    const creation = e.candidate?.creation;
    if (creation && e.block - creation.block >= 0 && e.block - creation.block <= 2000) {
      try {
        const [logs, supply] = await Promise.all([
          this.rpc.request('eth_getLogs', [
            {
              address: token,
              fromBlock: hex(creation.block),
              toBlock: hex(e.block),
              topics: [getEventSelector(TRANSFERS[0])],
            },
          ]),
          this.rpc.read(token, TRANSFERS, 'totalSupply', [], e.block),
        ]);
        holders = flapHolders(
          logs,
          token,
          creation.block,
          e.block,
          supply,
          e.state.circulatingSupply,
        );
      } catch (error) {
        if (error?.code === 'CF_SUBREQUEST_BUDGET') throw error;
      }
    }
    const report = evaluateFlapRisk(
      token,
      {
        ...e,
        state: json(s),
        market: m,
        reserveUsd,
        holders,
        sellQuote: sellQuote === null ? null : String(sellQuote),
      },
      Math.min(e.at, m.updatedAt),
    );
    return report;
  }
}
