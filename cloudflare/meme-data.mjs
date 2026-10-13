import { keccak256, parseAbi, decodeEventLog, getEventSelector } from 'viem';
import { PublicBscData } from './public-data.mjs';
import { FlapBscData } from './flap-data.mjs';
import { evaluateMemeRisk } from '../bi-trade/lib/meme-risk.mjs';
import { establishedAsset } from '../bi-trade/lib/established-risk.mjs';
import { readTurnoverHistory } from './turnover-history.mjs';
import { currentRiskEvidence } from '../bi-trade/lib/token-risk-core.mjs';
import {
  FOUR_HELPER,
  FOUR_MANAGER,
  FLAP,
  CHAIN_CONFIG,
} from '../paper-terminal/src/server/adapters/types.js';
import { FOUR_ABI, FLAP_ABI } from '../paper-terminal/src/server/adapters/abi.js';
const WBNB = CHAIN_CONFIG.bsc.wrapped,
  DEAD = '0x000000000000000000000000000000000000dead',
  ZERO = '0x0000000000000000000000000000000000000000';
const ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getPair(address,address) view returns (address)',
  'function getPool(address,address,uint24) view returns (address)',
  'function fee() view returns (uint24)',
  'function decimals() view returns (uint8)',
  'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)',
]);
const addr = (v) => (typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null);
const TRANSFER = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
export const MIGRATIONS = parseAbi([
  'event LiquidityAdded(address base,uint256 offers,address quote,uint256 funds)',
  'event LaunchedToDEX(address token,address pool,uint256 amount,uint256 eth)',
]);
export const POOL_SWAP = parseAbi([
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
]);
export function swapTurnover(logs, pool, fromBlock, toBlock, quote0) {
  if (!Array.isArray(logs) || logs.length > 4000) throw Error('池换手样本无效或过大');
  let quoteRaw = 0n,
    buys = 0,
    sells = 0;
  const seen = new Set();
  for (const l of logs) {
    if (l.removed) continue;
    if (
      addr(l.address) !== pool ||
      !/^0x[0-9a-f]{1,12}$/i.test(l.blockNumber ?? '') ||
      Number(BigInt(l.blockNumber)) < fromBlock ||
      Number(BigInt(l.blockNumber)) > toBlock ||
      !/^0x[0-9a-f]{64}$/i.test(l.blockHash ?? '') ||
      !/^0x[0-9a-f]{64}$/i.test(l.transactionHash ?? '') ||
      !/^0x[0-9a-f]{1,12}$/i.test(l.logIndex ?? '')
    )
      throw Error('池换手事件身份或范围未核实');
    const key = l.blockHash + ':' + l.transactionHash + ':' + l.logIndex;
    if (seen.has(key)) throw Error('池换手样本重复');
    seen.add(key);
    const { args } = decodeEventLog({
        abi: POOL_SWAP,
        data: l.data,
        topics: l.topics,
        strict: true,
      }),
      incoming = quote0 ? args.amount0In : args.amount1In,
      outgoing = quote0 ? args.amount0Out : args.amount1Out;
    quoteRaw += incoming + outgoing;
    if (incoming > 0n) buys++;
    if (outgoing > 0n) sells++;
  }
  return { quoteRaw, buys, sells };
}
// Bootstrap discovery only. Every entry still needs current launchpad, official
// pool, sell simulation and risk proofs; no price or clean labels are seeded.
export const MEME_BOOTSTRAP = [
  ['0x6bdcce4a559076e37755a78ce0c06214e59e4444', 'B'],
  ['0x924fa68a0fc644485b8df8abfa0a41c2e7744444', '币安人生'],
  ['0xeccbb861c0dda7efd964010085488b69317e4444', '龙虾'],
  ['0x82ec31d69b3c289e541b50e30681fd1acad24444', '哈基米'],
  ['0x6d5ad1592ed9d6d1df9b93c793ab759573ed6714', 'Broccoli'],
  ['0xe747e54783ba3f77a8e5251a3cba19ebe9c0e197', 'TAKE'],
].map(([address, symbol]) => ({
  id: address,
  address,
  symbol,
  name: symbol,
  category: 'meme',
  label: 'Meme',
  discoverySource: 'Known launchpad contract · current identity pending',
}));
export function migrationCandidates(logs, fromBlock, toBlock, at) {
  if (!Array.isArray(logs) || logs.length > 2000) throw Error('毕业事件样本无效');
  const rows = [];
  for (const l of logs) {
    if (l.removed) continue;
    if (
      ![FOUR_MANAGER, FLAP].includes(addr(l.address)) ||
      !/^0x[0-9a-f]{1,12}$/i.test(l.blockNumber ?? '') ||
      Number(BigInt(l.blockNumber)) < fromBlock ||
      Number(BigInt(l.blockNumber)) > toBlock ||
      !/^0x[0-9a-f]{64}$/i.test(l.blockHash ?? '') ||
      !/^0x[0-9a-f]{64}$/i.test(l.transactionHash ?? '')
    )
      throw Error('毕业事件身份与范围未核实');
    const d = decodeEventLog({ abi: MIGRATIONS, data: l.data, topics: l.topics, strict: true });
    if ((d.eventName === 'LiquidityAdded') !== (addr(l.address) === FOUR_MANAGER))
      throw Error('毕业事件与发行平台不一致');
    const token = addr(d.args.base ?? d.args.token);
    if (!token || establishedAsset(token)) continue;
    if (d.eventName === 'LiquidityAdded' && ![ZERO, WBNB].includes(addr(d.args.quote))) continue;
    rows.push({
      id: token,
      address: token,
      symbol: token.slice(0, 10),
      name: token,
      category: 'meme',
      label: 'launchpad-origin',
      platform: d.eventName === 'LaunchedToDEX' ? 'flap' : 'four',
      discoverySource: 'BSC launchpad migration event',
      discoveryBlock: Number(BigInt(l.blockNumber)),
      discoveryHash: l.blockHash,
      discoveryTx: l.transactionHash,
      at,
    });
  }
  return [
    ...new Map(
      rows.sort((a, b) => b.discoveryBlock - a.discoveryBlock).map((c) => [c.address, c]),
    ).values(),
  ];
}
export function fourCandidates(value, at, preserveOrder = false) {
  const rows = Array.isArray(value?.data) ? value.data : [],
    seen = new Set();
  return rows
    .filter((x) => {
      const a = addr(x.tokenAddress);
      if (
        !a ||
        seen.has(a) ||
        establishedAsset(a) ||
        ![0, '0'].includes(x.networkCode) ||
        x.status !== 'TRADE' ||
        x.symbol !== 'BNB' ||
        Number(x.taxFee ?? 0) > 0 ||
        Number(x.taxFeeSell ?? 0) > 0 ||
        !String(x.tag ?? '')
          .split(/[, ]+/)
          .includes('Meme')
      )
        return false;
      seen.add(a);
      return true;
    })
    .sort((a, b) => (preserveOrder ? 0 : Number(b.day1Vol ?? 0) - Number(a.day1Vol ?? 0)))
    .map((x) => ({
      id: addr(x.tokenAddress),
      address: addr(x.tokenAddress),
      symbol: String(x.shortName ?? 'Meme').slice(0, 60),
      name: String(x.name ?? x.shortName ?? 'Meme').slice(0, 100),
      category: 'meme',
      discoverySource: 'Four.meme',
      label: 'Meme',
      at,
    }));
}
export function geckoPair(value, token) {
  const rows = Array.isArray(value?.data) ? value.data : [];
  return (
    rows
      .map((x) => {
        const a = x.attributes ?? {},
          base = addr(x.relationships?.base_token?.data?.id?.replace(/^bsc_/, '')),
          quote = addr(x.relationships?.quote_token?.data?.id?.replace(/^bsc_/, '')),
          dex = x.relationships?.dex?.data?.id;
        if (
          base !== token ||
          quote !== WBNB ||
          !['pancakeswap_v2', 'pancakeswap-v3', 'pancakeswap_v3'].includes(dex)
        )
          return null;
        return {
          chainId: 'bsc',
          dexId: 'pancakeswap',
          pairAddress: addr(a.address),
          baseToken: { address: base, symbol: a.name?.split(' / ')[0] },
          quoteToken: { address: quote },
          labels: [dex === 'pancakeswap_v2' ? 'v2' : 'v3'],
          priceUsd: a.base_token_price_usd,
          liquidity: { usd: Number(a.reserve_in_usd) },
          volume: { h24: Number(a.volume_usd?.h24) },
          priceChange: a.price_change_percentage,
          txns: a.transactions,
          pairCreatedAt: Date.parse(a.pool_created_at),
          chartSource: 'GeckoTerminal',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0] ?? null
  );
}
export function selectDexPair(value, token) {
  return (
    (Array.isArray(value) ? value : [])
      .filter(
        (p) =>
          p.chainId === 'bsc' &&
          p.dexId === 'pancakeswap' &&
          addr(p.baseToken?.address) === token &&
          addr(p.quoteToken?.address) === WBNB &&
          addr(p.pairAddress) &&
          p.labels?.some((x) => ['v2', 'v3'].includes(x)),
      )
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0] ?? null
  );
}
export function transferClusters(logs, holders, token, fromBlock, toBlock) {
  if (!Array.isArray(logs) || logs.length > 10000) throw Error('转账样本无效或过大');
  const allowed = new Set(holders.map((h) => addr(h.address)).filter(Boolean)),
    groups = new Map();
  for (const l of logs) {
    if (
      addr(l.address) !== token ||
      !/^0x[0-9a-f]{1,12}$/i.test(l.blockNumber ?? '') ||
      Number(BigInt(l.blockNumber)) < fromBlock ||
      Number(BigInt(l.blockNumber)) > toBlock ||
      l.topics?.length !== 3 ||
      l.topics.some((t) => !/^0x[0-9a-f]{64}$/i.test(t)) ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(l.topics[1]) ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(l.topics[2]) ||
      !/^0x[0-9a-f]{64}$/i.test(l.data ?? '') ||
      l.topics?.[0] !== TRANSFER ||
      !/^0x[0-9a-f]{64}$/i.test(l.transactionHash ?? '')
    )
      throw Error('转账样本身份、区块范围或格式未核实');
    if (l.removed || BigInt(l.data) === 0n) continue;
    const to = addr('0x' + String(l.topics?.[2] ?? '').slice(-40));
    if (!allowed.has(to)) continue;
    const g = groups.get(l.transactionHash) ?? new Set();
    g.add(to);
    groups.set(l.transactionHash, g);
  }
  return [...groups]
    .filter(([, v]) => v.size >= 2)
    .map(([transactionHash, v]) => ({ transactionHash, addresses: [...v] }));
}
export class MemeBscData extends PublicBscData {
  constructor(store, rpc, options = {}) {
    super(store, rpc, options);
    this.flap = new FlapBscData(store, rpc, this, options);
  }
  status() {
    const s = this.store.get('cloud-settings', 'meme-chain-index') ?? {},
      rpc = this.rpc.statusFor?.('eth_getLogs') ?? this.rpc.status?.() ?? {};
    return [
      ...super.status(),
      this.flap.status(),
      {
        source: 'BSC launchpad events',
        ...s,
        limited: rpc.limited ?? false,
        retryAt: rpc.retryAt ?? 0,
      },
    ];
  }
  async scanMigrations() {
    const previous = this.store.get('cloud-settings', 'meme-chain-index');
    if (previous && this.now() - previous.at >= 0 && this.now() - previous.at < 300000) return [];
    try {
      const b = await this.rpc.block(),
        toBlock = Math.max(0, b.number - 4),
        fromBlock = Math.max(0, toBlock - 1999);
      const logs = await this.rpc.request('eth_getLogs', [
        {
          address: [FOUR_MANAGER, FLAP],
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: '0x' + toBlock.toString(16),
          topics: [MIGRATIONS.map(getEventSelector)],
        },
      ]);
      const rows = migrationCandidates(logs, fromBlock, toBlock, this.now());
      this.store.put('cloud-settings', {
        id: 'meme-chain-index',
        at: this.now(),
        fromBlock,
        toBlock,
        lastSuccessAt: this.now(),
        lastError: null,
        count: rows.length,
      });
      return rows;
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      this.store.put('cloud-settings', {
        ...previous,
        id: 'meme-chain-index',
        at: this.now(),
        lastError: '毕业事件暂未取得',
      });
      return [];
    }
  }
  supports(token) {
    return (
      !establishedAsset(token) &&
      this.store.get('cloud-meme-candidates', String(token).toLowerCase())?.category === 'meme'
    );
  }
  candidates() {
    return this.store
      .all('cloud-meme-candidates')
      .filter((c) => c.active !== false)
      .sort((a, b) => a.entryRank - b.entryRank)
      .slice(0, 12);
  }
  async discover() {
    const current = this.store.get('cloud-settings', 'meme-discovery');
    if (
      current &&
      this.now() - current.at >= 0 &&
      this.now() - current.at < 60000 &&
      this.candidates().length
    )
      return this.candidates();
    const launches = await this.flap.discover();
    const lists = [];
    for (const type of ['VOL', 'NEW']) {
      try {
        const d = await this.read('four', '/public/token/search', {
          type,
          listType: 'NOR_DEX',
          pageIndex: 1,
          pageSize: 30,
          status: 'TRADE',
          sort: 'DESC',
          symbol: 'BNB',
          tag: ['Meme'],
        });
        lists.push(fourCandidates(d.value, d.at, type === 'NEW').slice(0, type === 'VOL' ? 8 : 4));
      } catch (e) {
        if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      }
    }
    // Mix established memes with recent graduated launches. Do not pin the
    // universe to a few blocked leaders or broaden it to unrelated assets.
    let rows = [];
    for (let i = 0; i < 8; i++) for (const list of lists) if (list[i]) rows.push(list[i]);
    const hasFourRows = rows.length > 0,
      previous = this.candidates(),
      recentlyScreened = (c) => {
        const r = this.store.get('token-risk-reports', c.address);
        return r?.buyAllowed === true && currentRiskEvidence(r, this.now());
      },
      known = previous
        .filter((c) => {
          const binding = this.store.get('cloud-meme-pools', c.address);
          return (
            !establishedAsset(c.address) &&
            /^0x[0-9a-f]{64}$/i.test(binding?.codeHash ?? '') &&
            binding.pair &&
            selectDexPair([binding.pair], c.address)
          );
        })
        .sort((a, b) => Number(recentlyScreened(b)) - Number(recentlyScreened(a)))
        .slice(0, 4);
    if (!rows.length) {
      try {
        const d = await this.read(
          'gecko',
          '/networks/bsc/trending_pools?include=base_token,quote_token,dex',
        );
        const included = new Map((d.value?.included ?? []).map((t) => [t.id, t.attributes]));
        rows = (d.value?.data ?? [])
          .filter((p) =>
            ['four-meme', 'flap', 'pancakeswap_v2', 'pancakeswap_v3'].includes(
              p.relationships?.dex?.data?.id,
            ),
          )
          .map((p) => {
            const id = p.relationships?.base_token?.data?.id,
              a = addr(id?.replace(/^bsc_/, '')),
              t = included.get(id) ?? {};
            return {
              id: a,
              address: a,
              symbol: String(t.symbol ?? 'Meme').slice(0, 60),
              name: String(t.name ?? 'Meme').slice(0, 100),
              category: 'meme',
              discoverySource: 'GeckoTerminal · launchpad identity pending',
              label: 'launchpad-origin',
              at: d.at,
            };
          })
          .filter((c) => c.address && !establishedAsset(c.address));
      } catch (e) {
        if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      }
    }
    const migrations = await this.scanMigrations();
    const bootstrapCursor = Number.isInteger(current?.bootstrapCursor)
        ? current.bootstrapCursor
        : 0,
      bootstrap = MEME_BOOTSTRAP.map((_, i) => ({
        ...MEME_BOOTSTRAP[(bootstrapCursor + i) % MEME_BOOTSTRAP.length],
        at: this.now(),
      }));
    // Route bindings only preserve discovery hints, never freshness or permission.
    // During list outages reserve space for rediscovery and cap the combined
    // unverified pool/event arrivals; a full backlog must not crowd both out.
    rows = hasFourRows
      ? [...known, ...migrations.slice(0, 4), ...rows, ...previous, ...bootstrap]
      : [
          ...known,
          ...bootstrap.slice(0, 4),
          ...[...migrations, ...rows].slice(0, 4),
          ...previous,
          ...bootstrap,
        ];
    const knownFlap = previous
      .filter(
        (c) =>
          this.flap.supports(c.address) &&
          this.store.get('cloud-flap-evidence', c.address)?.originVerified === true,
      )
      .sort((a, b) => Number(recentlyScreened(b)) - Number(recentlyScreened(a)))
      .slice(0, 4);
    const flapCursor = Number.isInteger(current?.flapCursor) ? current.flapCursor : 0;
    const freshFlap = launches.length
      ? Array.from(
          { length: Math.min(4, launches.length) },
          (_, i) => launches[(flapCursor + i) % launches.length],
        )
      : [];
    rows = [...knownFlap, ...freshFlap, ...rows];
    const seen = new Set();
    rows = rows.filter((c) => !seen.has(c.address) && seen.add(c.address)).slice(0, 12);
    if (!rows.length) throw Error('独立 Meme 发现暂未返回候选');
    const active = new Set(rows.map((c) => c.address));
    for (const old of this.store.all('cloud-meme-candidates'))
      if (old.active !== false && !active.has(old.id))
        this.store.put('cloud-meme-candidates', { ...old, active: false });
    for (const [entryRank, c] of rows.entries())
      this.store.put('cloud-meme-candidates', { ...c, entryRank, active: true });
    const held = new Set(
      this.store
        .all('paper-lots')
        .filter((l) => BigInt(l.remainingRaw) > 0n)
        .map((l) => l.token),
    );
    for (const old of this.store.all('cloud-meme-candidates'))
      if (old.active === false && !held.has(old.id))
        for (const kind of ['cloud-meme-candidates', 'cloud-meme-pools', 'cloud-flap-evidence'])
          this.store.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, old.id);
    this.store.put('cloud-settings', {
      id: 'meme-discovery',
      at: this.now(),
      bootstrapCursor: (bootstrapCursor + 2) % MEME_BOOTSTRAP.length,
      flapCursor: launches.length ? (flapCursor + 2) % launches.length : 0,
    });
    return this.candidates();
  }
  async chart(token) {
    let row, pair;
    try {
      row = await this.read('dex', '/token-pairs/v1/bsc/' + token);
      pair = selectDexPair(row.value, token);
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
    }
    if (!pair) {
      try {
        row = await this.read(
          'gecko',
          '/networks/bsc/tokens/' + token + '/pools?include=base_token,quote_token,dex',
        );
        pair = geckoPair(row.value, token);
      } catch (e) {
        if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      }
    }
    if (!pair) return this.chainChart(token);
    return { pair, at: row.at };
  }
  async chainChart(token) {
    const b = await this.rpc.block(),
      fx = this.store.get('cloud-settings', 'native-fx');
    if (
      !fx ||
      fx.source !== 'Chainlink BNB/USD · BSC' ||
      !Number.isFinite(fx.usd) ||
      fx.usd <= 0 ||
      this.now() < fx.at ||
      this.now() - fx.at >= 90000 ||
      this.now() - b.time > 15000
    )
      throw Error('链上 Meme 行情所需的链头或美元参考过期');
    const factory = CHAIN_CONFIG.bsc.v2Factory,
      pool = addr(await this.rpc.read(factory, ABI, 'getPair', [token, WBNB], b.number));
    if (!pool || pool === ZERO) throw Error('尚未核实该 Meme 的 Pancake V2/V3 WBNB 池');
    const [t0, t1, pf, reserves, decimals] = await Promise.all([
      this.rpc.read(pool, ABI, 'token0', [], b.number),
      this.rpc.read(pool, ABI, 'token1', [], b.number),
      this.rpc.read(pool, ABI, 'factory', [], b.number),
      this.rpc.read(pool, ABI, 'getReserves', [], b.number),
      this.rpc.read(token, ABI, 'decimals', [], b.number),
    ]);
    if (
      addr(pf) !== factory ||
      ![addr(t0), addr(t1)].includes(token) ||
      ![addr(t0), addr(t1)].includes(WBNB) ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 36
    )
      throw Error('链上 Meme 池身份或精度未核实');
    const quote0 = addr(t0) === WBNB,
      qr = BigInt(reserves[quote0 ? 0 : 1]),
      tr = BigInt(reserves[quote0 ? 1 : 0]);
    if (qr <= 0n || tr <= 0n) throw Error('链上 Meme 池没有可核实的储备');
    const sample = await this.turnoverWindow(pool, b, quote0, fx.usd),
      priceUsd = (Number(qr) / 1e18 / (Number(tr) / 10 ** decimals)) * fx.usd;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw Error('链上 Meme 价格未核实');
    return {
      at: sample.at,
      pair: {
        chainId: 'bsc',
        dexId: 'pancakeswap',
        pairAddress: pool,
        baseToken: { address: token },
        quoteToken: { address: WBNB },
        labels: ['v2'],
        priceUsd: String(priceUsd),
        liquidity: { usd: (Number(qr) / 1e18) * fx.usd * 2 },
        volume: { h24: (Number(sample.quoteRaw) / 1e18) * fx.usd },
        priceChange: null,
        txns: null,
        chartSource: 'BSC RPC',
        volumeWindow: {
          kind: 'recent-swap-lower-bound',
          fromBlock: sample.fromBlock,
          toBlock: sample.toBlock,
          fromTime: sample.fromTime,
          quoteRaw: sample.quoteRaw,
          buys: sample.buys,
          sells: sample.sells,
          usdReferenceAt: fx.at,
          sampledRanges: sample.sampledRanges ?? null,
          hasGaps: sample.hasGaps ?? null,
          latestSample: sample.latestSample ?? null,
          coverage: 'rolling-observed-range',
          dayComplete: false,
        },
      },
    };
  }
  async turnoverWindow(pool, b, quote0, nativeUsd) {
    return readTurnoverHistory(
      this,
      pool,
      b,
      quote0,
      nativeUsd,
      getEventSelector(POOL_SWAP[0]),
      swapTurnover,
    );
  }
  async tradingEvidence(token) {
    if (!this.supports(token)) throw Error('Meme 候选来源尚未核实');
    const id = 'meme-trading:' + token,
      old = this.store.get('cloud-public-cache', id);
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 60000) return old.value;
    if (this.pending.has(id)) return this.pending.get(id);
    const task = (async () => {
      let chart;
      try {
        chart = await this.chart(token);
      } catch (e) {
        if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
        const binding = this.store.get('cloud-meme-pools', token);
        if (!binding) throw e;
        // Historical identity is only a route hint; validate it again on-chain
        // and obtain fresh sell evidence. Old chart age still blocks entries.
        chart = { pair: binding.pair, at: binding.marketDataAt };
      }
      const pool = addr(chart.pair.pairAddress),
        b = await this.rpc.block();
      let origin = false;
      try {
        const f = await this.rpc.read(FOUR_HELPER, FOUR_ABI, 'getTokenInfo', [token], b.number);
        origin =
          Number(f[0]) === 2 &&
          addr(f[1]) === FOUR_MANAGER &&
          [ZERO, WBNB].includes(addr(f[2])) &&
          f[11] === true;
      } catch (e) {
        if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      }
      if (!origin) {
        try {
          const f = await this.rpc.read(FLAP, FLAP_ABI, 'getTokenV8Safe', [token], b.number);
          origin =
            Number(f.status) === 4 &&
            addr(f.pool) === pool &&
            [ZERO, WBNB].includes(addr(f.quoteTokenAddress));
        } catch (e) {
          if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
        }
      }
      if (!origin) throw Error('该候选未通过 Four.meme / Flap 链上发行身份核验');
      const v3 = chart.pair.labels.includes('v3'),
        factory = v3 ? CHAIN_CONFIG.bsc.v3Factory : CHAIN_CONFIG.bsc.v2Factory;
      const [t0, t1, pf] = await Promise.all(
        ['token0', 'token1', 'factory'].map((n) => this.rpc.read(pool, ABI, n, [], b.number)),
      );
      if (
        ![addr(t0), addr(t1)].includes(token) ||
        ![addr(t0), addr(t1)].includes(WBNB) ||
        addr(pf) !== factory
      )
        throw Error('Meme 池资产或工厂身份不一致');
      const fee = v3 ? await this.rpc.read(pool, ABI, 'fee', [], b.number) : null,
        official = await this.rpc.read(
          factory,
          ABI,
          v3 ? 'getPool' : 'getPair',
          v3 ? [token, WBNB, fee] : [token, WBNB],
          b.number,
        );
      if (addr(official) !== pool) throw Error('Meme 池不是已核实的官方工厂池');
      const [check, code, supply, burn, zero, poolBalance] = await Promise.all([
        this.read('safety', '/v2/IsHoneypot?chainID=56&address=' + token + '&pair=' + pool),
        this.rpc.request('eth_getCode', [token, '0x' + b.number.toString(16)]),
        this.rpc.read(token, ABI, 'totalSupply', [], b.number),
        this.rpc.read(token, ABI, 'balanceOf', [DEAD], b.number),
        this.rpc.read(token, ABI, 'balanceOf', [ZERO], b.number),
        this.rpc.read(token, ABI, 'balanceOf', [pool], b.number),
      ]);
      if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code))
        throw Error('Meme 合约代码缺失');
      const codeHash = keccak256(code),
        binding = this.store.get('cloud-meme-pools', token);
      if (binding?.codeHash && binding.codeHash !== codeHash)
        throw Error('Meme 合约运行代码发生变化');
      const value = {
        pair: chart.pair,
        check: check.value,
        candidate: this.store.get('cloud-meme-candidates', token),
        proof: {
          originVerified: true,
          poolVerified: true,
          pool,
          codeHash,
          totalSupply: String(supply),
          burnBalance: String(burn),
          zeroBalance: String(zero),
          poolBalance: String(poolBalance),
          block: b.number,
        },
        at: check.at,
        marketDataAt: chart.at,
      };
      this.store.put('cloud-meme-pools', {
        id: token,
        pair: chart.pair,
        marketDataAt: chart.at,
        codeHash,
      });
      this.store.put('cloud-public-cache', { id, at: value.at, value });
      return value;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
  async metadata(token) {
    if (this.flap.supports(token)) return this.flap.metadata(token);
    const d = await this.tradingEvidence(token),
      c = d.check,
      p = d.pair;
    if (
      c?.simulationSuccess !== true ||
      c?.honeypotResult?.isHoneypot !== false ||
      ['buyTax', 'sellTax', 'transferTax'].some((k) => c?.simulationResult?.[k] !== 0) ||
      c?.contractCode?.isProxy !== false ||
      c?.contractCode?.hasProxyCalls !== false ||
      c?.contractCode?.openSource !== true ||
      c?.contractCode?.rootOpenSource !== true ||
      String(c?.chain?.id) !== '56' ||
      String(c?.pair?.chainId) !== '56' ||
      addr(c?.token?.address) !== token ||
      addr(c?.pair?.pair?.address) !== d.proof.pool ||
      !Number.isFinite(d.at) ||
      this.now() < d.at ||
      this.now() - d.at >= 120000
    )
      throw Error('Meme 买卖检测、零税或合约身份尚未核实');
    return {
      id: token,
      at: d.at,
      marketDataAt: d.marketDataAt,
      source: 'meme-bsc',
      info: {
        address: token,
        symbol: c.token.symbol ?? d.candidate.symbol,
        name: c.token.name ?? d.candidate.name,
        biggest_pool_address: d.proof.pool,
        liquidity: p.liquidity?.usd,
        price: { price: p.priceUsd, volume_24h: p.volume?.h24 },
        priceChange: p.priceChange,
        txns: p.txns,
        chartSource: p.chartSource ?? 'DEX Screener',
        volumeWindow: p.volumeWindow ?? null,
      },
      security: {
        address: token,
        buy_tax: 0,
        sell_tax: 0,
        is_honeypot: false,
        verifiedPool: d.proof.pool,
      },
    };
  }
  async riskReport(token) {
    if (this.flap.supports(token)) return this.flap.riskReport(token);
    const d = await this.tradingEvidence(token),
      holders = await this.read('safety', '/v1/TopHolders?chainID=56&address=' + token);
    let transferSample = { available: false, fromBlock: null, toBlock: null, clusters: [] };
    try {
      const b = await this.rpc.block(),
        from = Math.max(0, b.number - 200),
        logs = await this.rpc.request('eth_getLogs', [
          {
            address: token,
            fromBlock: '0x' + from.toString(16),
            toBlock: '0x' + b.number.toString(16),
            topics: [TRANSFER],
          },
        ]);
      transferSample = {
        available: true,
        fromBlock: from,
        toBlock: b.number,
        clusters: transferClusters(logs, holders.value?.holders ?? [], token, from, b.number),
      };
    } catch {}
    return evaluateMemeRisk(
      token,
      { ...d, holders: holders.value, transferSample },
      Math.min(d.at, d.marketDataAt, holders.at),
    );
  }
}
