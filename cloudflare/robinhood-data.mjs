import { parseAbi, decodeEventLog, getEventSelector, keccak256 } from 'viem';
import {
  PONS_V2,
  ZERO,
  CHAIN_CONFIG,
  ORDINARY_RECIPIENT,
} from '../paper-terminal/src/server/adapters/types.js';
import { PONS_V2_ABI, ERC20 } from '../paper-terminal/src/server/adapters/abi.js';
import { poolId } from '../paper-terminal/src/server/adapters/venues.js';

export const PONS_EVENTS = parseAbi([
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)',
  'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)',
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
]);
const DETAILS = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function realQuoteReserve() view returns (uint256)',
  'function getLiquidity(bytes32 id) view returns (uint128)',
  'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'function getTokenInfo() view returns (address tokenDeployer,string tokenLogo,string tokenDescription,Socials tokenSocials)',
]);
const hex = (n) => '0x' + n.toString(16);
const lower = (x) => String(x).toLowerCase();
const json = (x) =>
  JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
const validHash = (x) => /^0x[0-9a-f]{64}$/i.test(x ?? '');
export function ponsLaunches(logs, from, to) {
  if (!Array.isArray(logs) || logs.length > 4000) throw Error('发行事件样本无效');
  const seen = new Set();
  return logs
    .filter((l) => !l.removed)
    .map((l) => {
      const block = Number(BigInt(l.blockNumber));
      if (
        lower(l.address) !== PONS_V2 ||
        !validHash(l.blockHash) ||
        !validHash(l.transactionHash) ||
        !/^0x[0-9a-f]+$/i.test(l.logIndex ?? '') ||
        !Number.isSafeInteger(block) ||
        block < from ||
        block > to
      )
        throw Error('Pons V2 发行事件身份无效');
      const id = `${l.blockHash}:${l.transactionHash}:${l.logIndex}`;
      if (seen.has(id)) throw Error('重复发行事件');
      seen.add(id);
      const e = decodeEventLog({
          abi: [PONS_EVENTS[0]],
          topics: l.topics,
          data: l.data,
          strict: true,
        }),
        a = e.args;
      return {
        id: lower(a.token),
        address: lower(a.token),
        curve: lower(a.curve),
        quote: lower(a.pairToken),
        deployer: lower(a.deployer),
        chain: 'robinhood',
        platform: 'pons-v2',
        category: 'meme',
        discoverySource: 'Pons V2 factory TokenLaunched',
        creation: {
          block,
          blockHash: lower(l.blockHash),
          transactionHash: lower(l.transactionHash),
        },
        at: Date.now(),
      };
    });
}

export class RobinhoodData {
  constructor(store, rpc, { fetchImpl = fetch, discoveryIntervalMs = 30000 } = {}) {
    Object.assign(this, { store, rpc, fetch: fetchImpl, discoveryIntervalMs });
    this.market = null;
    this.pending = new Map();
  }
  candidates() {
    return this.store
      .all('pons-launches')
      .sort((a, b) => b.creation.block - a.creation.block)
      .slice(0, 24)
      .map((c, i) => ({ ...c, entryRank: i }));
  }
  supports(token) {
    return (
      !!this.store.get('pons-launches', token) ||
      this.store.get('pons-evidence', token)?.originVerified === true
    );
  }
  status() {
    return {
      ...this.store.get('cloud-settings', 'pons-index'),
      chain: 'robinhood',
      platform: 'pons-v2',
      ...this.rpc.status(),
    };
  }
  async discover() {
    const old = this.store.get('cloud-settings', 'pons-index');
    if (old && Date.now() >= old.at && Date.now() - old.at < this.discoveryIntervalMs)
      return this.candidates();
    try {
      const head = await this.rpc.block(),
        to = Math.max(0, head.number - 4),
        from = Math.max(0, to - 19999, (old?.toBlock ?? to - 19999) - 4);
      const logs = await this.rpc.request('eth_getLogs', [
        {
          address: PONS_V2,
          fromBlock: hex(from),
          toBlock: hex(to),
          topics: [getEventSelector(PONS_EVENTS[0])],
        },
      ]);
      const anchor = await this.rpc.block(to, true),
        rows = ponsLaunches(logs, from, to);
      const after = await this.rpc.block(to, true);
      if (anchor.hash !== after.hash) throw Error('发行事件观测发生重组');
      for (const row of rows) {
        const previous = this.store.get('pons-launches', row.id);
        if (previous?.creation.blockHash !== row.creation.blockHash)
          this.store.put('pons-launches', row);
      }
      const held = new Set(
        this.store
          .all('paper-lots')
          .filter((l) => BigInt(l.remainingRaw) > 0n)
          .map((l) => l.token),
      );
      for (const row of this.store
        .all('pons-launches')
        .sort((a, b) => b.creation.block - a.creation.block)
        .slice(96))
        if (!held.has(row.id))
          this.store.db
            .prepare('DELETE FROM entities WHERE kind=? AND id=?')
            .run('pons-launches', row.id);
      this.store.put('cloud-settings', {
        id: 'pons-index',
        at: Date.now(),
        fromBlock: from,
        toBlock: to,
        count: rows.length,
        gapBlocks: old?.toBlock ? Math.max(0, from - old.toBlock - 1) : 0,
        lastSuccessAt: Date.now(),
        lastError: null,
      });
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      this.store.put('cloud-settings', {
        ...old,
        id: 'pons-index',
        at: Date.now(),
        lastError: 'Pons V2 发行事件暂未取得',
      });
    }
    return this.candidates();
  }
  async evidence(token) {
    const block = await this.rpc.block();
    const state = await this.rpc.read(
      PONS_V2,
      PONS_V2_ABI,
      'getLaunchedToken',
      [token],
      block.number,
    );
    if (!state.exists || lower(state.token) !== token || ![0, 2].includes(Number(state.phase)))
      throw Error('Pons V2 发行身份或交易阶段未核实');
    if (![ZERO, CHAIN_CONFIG.robinhood.wrapped].includes(lower(state.pairToken)))
      throw Error('该 Pons V2 报价资产尚未接入；当前支持 ETH/WETH 交易对');
    const code = await this.rpc.request('eth_getCode', [token, hex(block.number)]);
    if (!code || code === '0x') throw Error('代币代码未核实');
    const old = this.store.get('pons-evidence', token),
      codeHash = keccak256(code);
    if (old?.codeHash && old.codeHash !== codeHash) throw Error('代币代码发生变化');
    const creation = this.store.get('pons-launches', token)?.creation;
    if (
      creation &&
      (await this.rpc.block(creation.block, true)).hash.toLowerCase() !== creation.blockHash
    )
      throw Error('发行区块发生重组');
    const evidence = {
      id: token,
      token,
      at: Date.now(),
      block: block.number,
      blockHash: block.hash,
      originVerified: true,
      codeHash,
      state: json(state),
    };
    this.store.put('pons-evidence', evidence);
    return evidence;
  }
  async metadata(token) {
    const e = await this.evidence(token),
      block = e.block;
    const [name, symbol, decimals] = await Promise.all([
      this.rpc.read(token, DETAILS, 'name', [], block),
      this.rpc.read(token, DETAILS, 'symbol', [], block),
      this.rpc.read(token, ERC20, 'decimals', [], block),
    ]);
    const old = this.store.get('pons-launches', token);
    if (old && (old.name !== name || old.symbol !== symbol))
      this.store.put('pons-launches', {
        ...old,
        name: String(name).slice(0, 100),
        symbol: String(symbol).slice(0, 60),
      });
    return {
      id: token,
      at: e.at,
      source: 'pons-v2',
      pons: { ...e.state, decimals: Number(decimals), codeHash: e.codeHash },
      info: { address: token, name, symbol, liquidity: null, price: {} },
      security: { address: token, is_honeypot: null, buy_tax: null, sell_tax: null },
    };
  }
  async marketStats(route, block, quoteUsd) {
    if (route.kind === 'pons-v2') {
      const [real, reserves] = await Promise.all([
        this.rpc.read(route.curve, DETAILS, 'realQuoteReserve', [], block),
        this.rpc.read(route.curve, PONS_V2_ABI, 'getReserves', [], block),
      ]);
      return {
        reserveUsd: (Number(real) / 1e18) * quoteUsd,
        liquidityUsd: (Number(real) / 1e18) * quoteUsd,
        liquidityQuality: 'actual-curve-reserve',
        progressPct: (Number(real) / Number(route.state.graduationThreshold)) * 100,
        curveVirtualReserveUsd: (Number(reserves[0]) / 1e18) * quoteUsd,
        curveDepthQuality: 'curve-model-estimate',
      };
    }
    if (route.kind !== 'v4') throw Error('该路线不是 Pons V2');
    const id = poolId(route.key),
      [l, slot] = await Promise.all([
        this.rpc.read(CHAIN_CONFIG.robinhood.v4State, DETAILS, 'getLiquidity', [id], block),
        this.rpc.read(CHAIN_CONFIG.robinhood.v4State, DETAILS, 'getSlot0', [id], block),
      ]);
    const sqrt = Number(slot[0]) / 2 ** 96,
      quote0 = route.key.currency0 === route.quote,
      depth = ((Number(l) * (quote0 ? 1 / sqrt : sqrt)) / 1e18) * quoteUsd;
    if (!Number.isFinite(depth) || depth <= 0) throw Error('毕业池深度未核实');
    return {
      reserveUsd: null,
      liquidityUsd: depth,
      liquidityQuality: 'active-liquidity-estimate',
      progressPct: 100,
      curveVirtualReserveUsd: null,
      curveDepthQuality: null,
    };
  }
  async externalEntry(token) {
    await this.evidence(token);
    return {
      id: token,
      address: token,
      category: 'meme',
      chain: 'robinhood',
      platform: 'pons-v2',
      originVerified: true,
    };
  }
  async riskReport(token) {
    const e = await this.evidence(token),
      m = await this.market.refreshMarket(token),
      b = await this.rpc.block();
    const route = await this.market.route('robinhood', token, b.number);
    const sell = await this.market.venues.robinhood.quote(
      route,
      'sell',
      10n ** 18n,
      b.number,
      ORDINARY_RECIPIENT,
    );
    const good = m.quality === 'verified' && m.priceUsd > 0 && m.liquidityUsd > 0 && sell.out > 0n;
    return {
      id: token,
      token,
      chain: 'robinhood',
      source: 'Pons V2 factory / curve / Uniswap V4',
      policy: 'robinhood-pons-v2-paper-v1',
      policyVersion: 1,
      fetchedAt: Math.min(e.at, m.updatedAt),
      state: good ? 'screened-limited' : 'unknown',
      buyAllowed: good,
      reasons: good ? [] : ['当前价格、储备或净卖出报价未核实'],
      warnings: [
        '仅核实发行身份、阶段、路线与模拟净报价；持仓集中度、捆绑、同源资金与完整安全审计仍未知。',
        '报价与估算费用不代表真实资金、签名、授权或整笔交易已验证。',
      ],
      metrics: {
        liquidityUsd: m.liquidityUsd,
        referencePriceUsd: m.priceUsd,
        holderCount: null,
        bundling: null,
        linkedFunding: null,
      },
      evidence: {
        block: e.block,
        blockHash: e.blockHash,
        codeHash: e.codeHash,
        originVerified: true,
      },
    };
  }
  async narrative(token) {
    const block = await this.rpc.block(),
      at = Date.now();
    const [, , description, socials] = await this.rpc.read(
      token,
      DETAILS,
      'getTokenInfo',
      [],
      block.number,
    );
    const sources = [];
    if (description)
      sources.push({
        id: 'pons-project-description',
        kind: 'project-self-report',
        independent: false,
        uri: `https://robinhoodchain.blockscout.com/token/${token}`,
        at,
        text: String(description).slice(0, 1600),
      });
    for (const k of ['twitter', 'telegram', 'website', 'discord', 'farcaster'])
      if (socials?.[k])
        sources.push({
          id: 'pons-project-' + k,
          kind: 'project-link-unverified',
          independent: false,
          uri: `https://robinhoodchain.blockscout.com/token/${token}`,
          at,
          text: String(socials[k]).slice(0, 512),
        });
    return { at, sources };
  }
}

export class EtherPrice {
  constructor(fetchImpl = fetch, now = Date.now) {
    Object.assign(this, { fetch: fetchImpl, now });
  }
  async read() {
    const r = await this.fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw Error('ETH 美元参考暂不可用');
    const { data } = await r.json(),
      usd = Number(data?.amount),
      at = this.now();
    if (data?.base !== 'ETH' || data?.currency !== 'USD' || !Number.isFinite(usd) || usd <= 0)
      throw Error('ETH 美元参考身份未核实');
    return {
      id: 'native-fx',
      usd,
      at,
      readAt: at,
      source: 'Coinbase ETH/USD spot · observed reference',
    };
  }
}
