import { establishedAsset } from './established-risk.mjs';
export const MEME_POLICY = Object.freeze({
  id: 'bsc-meme-paper-v1',
  minLiquidityUsd: 10000,
  minVolumeUsd: 1000,
  minHolders: 50,
  maxLargestFloatShare: 0.1,
  maxTopTenFloatShare: 0.5,
  maxSharedTxFloatShare: 0.25,
});
const addr = (v) => (typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null);
const num = (v) =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v))
    ? Number(v)
    : null;
const raw = (v) => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
export function evaluateMemeRisk(token, d, at = Date.now()) {
  token = addr(token);
  const missing = [],
    blocked = [],
    p = d?.pair,
    c = d?.check,
    proof = d?.proof,
    holders = d?.holders;
  if (
    !token ||
    establishedAsset(token) ||
    d?.candidate?.category !== 'meme' ||
    proof?.originVerified !== true
  )
    missing.push('Meme 来源与链上发行身份未核实');
  if (
    p?.chainId !== 'bsc' ||
    addr(p.baseToken?.address) !== token ||
    addr(p.quoteToken?.address) !== '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' ||
    addr(p.pairAddress) !== addr(proof?.pool) ||
    proof?.poolVerified !== true
  )
    missing.push('交易池的链、资产与官方工厂身份未核实');
  if (
    String(c?.chain?.id) !== '56' ||
    String(c?.pair?.chainId) !== '56' ||
    addr(c?.token?.address) !== token ||
    addr(c?.pair?.pair?.address) !== addr(proof?.pool)
  )
    missing.push('买卖检测与当前交易池身份不一致');
  if (c?.simulationSuccess !== true || typeof c?.honeypotResult?.isHoneypot !== 'boolean')
    missing.push('真实买卖检测尚未成功');
  if (c?.honeypotResult?.isHoneypot === true) blocked.push('检测到貔貅或禁止卖出');
  for (const k of ['buyTax', 'sellTax', 'transferTax']) {
    const n = num(c?.simulationResult?.[k]);
    if (n === null || n < 0) missing.push('买卖或转账税字段缺失');
    else if (n !== 0) blocked.push('当前模拟路线尚不支持该代币的转账税');
  }
  if (
    c?.contractCode?.openSource !== true ||
    c?.contractCode?.rootOpenSource !== true ||
    c?.contractCode?.isProxy !== false ||
    c?.contractCode?.hasProxyCalls !== false
  )
    missing.push('合约开源与非代理身份未核实');
  const level = num(c?.summary?.riskLevel);
  if (level === null) missing.push('安全检测等级缺失');
  else if (level >= 20) blocked.push('安全检测存在高风险');
  if ((c?.summary?.flags ?? []).some((f) => num(f.severityIndex) >= 10))
    blocked.push('安全检测存在中高风险标记');
  const liquidity = num(p?.liquidity?.usd),
    volume = num(p?.volume?.h24),
    price = num(p?.priceUsd),
    holderCount = num(c?.token?.totalHolders);
  if (!(liquidity >= MEME_POLICY.minLiquidityUsd)) blocked.push('池流动性不足1万美元或未核实');
  if (!(volume >= MEME_POLICY.minVolumeUsd)) blocked.push('24小时成交量不足1000美元或未核实');
  if (!(holderCount >= MEME_POLICY.minHolders)) blocked.push('持币地址不足50个或未核实');
  if (!(price > 0)) missing.push('独立行情价格缺失');
  const supply = raw(proof?.totalSupply),
    pool = raw(proof?.poolBalance),
    burn = raw(proof?.burnBalance),
    zero = raw(proof?.zeroBalance),
    hpSupply = raw(holders?.totalSupply);
  let float = null,
    largest = null,
    topTen = null,
    coverage = null;
  const normal = [],
    seen = new Set();
  if (
    !supply ||
    pool === null ||
    burn === null ||
    zero === null ||
    hpSupply !== supply ||
    pool + burn + zero >= supply
  )
    missing.push('链上总供应、池余额与持仓供应未核实');
  else {
    float = supply - pool - burn - zero;
    if (Number(float) / Number(supply) < 0.02) blocked.push('池外可交易筹码不足2%');
  }
  const rows = Array.isArray(holders?.holders) ? holders.holders : [];
  if (!rows.length) missing.push('持仓列表缺失');
  let observed = 0n;
  for (const h of rows) {
    const a = addr(h.address),
      n = raw(h.balance);
    if (
      !a ||
      n === null ||
      seen.has(a) ||
      typeof h.isContract !== 'boolean' ||
      (supply && n > supply)
    ) {
      missing.push('持仓地址、余额或地址类型未核实');
      continue;
    }
    seen.add(a);
    observed += n;
    if (
      ![
        addr(proof?.pool),
        '0x000000000000000000000000000000000000dead',
        '0x0000000000000000000000000000000000000000',
      ].includes(a) &&
      n > 0n
    )
      normal.push({ address: a, balance: n, isContract: h.isContract });
  }
  if (supply && observed > supply) blocked.push('持仓总额与总供应不一致');
  if (float && normal.length) {
    normal.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));
    largest = Number(normal[0].balance) / Number(float);
    topTen = normal.slice(0, 10).reduce((n, h) => n + Number(h.balance) / Number(float), 0);
    coverage = normal.reduce((n, h) => n + Number(h.balance) / Number(float), 0);
  } else missing.push('持仓集中度未核实');
  if (largest > MEME_POLICY.maxLargestFloatShare || topTen > MEME_POLICY.maxTopTenFloatShare)
    blocked.push('可流通持仓集中度超过10%单地址或50%前十地址上限');
  const clusters = Array.isArray(d?.transferSample?.clusters) ? d.transferSample.clusters : [];
  if (
    float &&
    clusters.some(
      (g) =>
        g.addresses?.length >= 2 &&
        g.addresses.reduce(
          (n, a) => n + Number(normal.find((h) => h.address === a)?.balance ?? 0n) / Number(float),
          0,
        ) > MEME_POLICY.maxSharedTxFloatShare,
    )
  )
    blocked.push('同一交易向多个当前持币地址分发的筹码超过可流通份额25%，存在关联持仓风险');
  const state = blocked.length ? 'blocked' : missing.length ? 'unknown' : 'screened-limited';
  return {
    id: token,
    token,
    chain: 'bsc',
    source: 'Four.meme / GeckoTerminal · Honeypot.is · BSC RPC',
    policy: MEME_POLICY.id,
    policyVersion: 3,
    fetchedAt: at,
    state,
    buyAllowed: state === 'screened-limited',
    reasons: [...new Set([...blocked, ...missing])],
    warnings: [
      'Meme 模拟采用已观测风险筛查；完整捆绑、老鼠仓、同源资金和黑名单能力仍可能未知，不能视为安全保证。',
      '关联检查仅覆盖标明区块范围内的代币转账样本；不同交易或较早的关联钱包可能未被检出。',
      ...(p?.volumeWindow
        ? [
            '换手额仅为标明区块范围内的真实池成交，按当前美元参考换算，是近24小时的部分样本下界；不是全天总成交额，涨跌窗口未取得。',
          ]
        : []),
    ],
    metrics: {
      poolSupplyShare: supply && pool !== null ? Number(pool) / Number(supply) : null,
      burnSupplyShare:
        supply && burn !== null && zero !== null ? Number(burn + zero) / Number(supply) : null,
      tradeableFloatShare: float ? Number(float) / Number(supply) : null,
      largestObservedFloatShare: largest,
      topTenObservedFloatShare: topTen,
      observedFloatCoverage: coverage,
      bundlerObservedFloatShare: null,
      bundlerVolumeShare: null,
      ratObservedFloatShare: null,
      linkedFunding: null,
      blacklist: null,
      honeypot: c?.honeypotResult?.isHoneypot ?? null,
      buyTaxPct: num(c?.simulationResult?.buyTax),
      sellTaxPct: num(c?.simulationResult?.sellTax),
      liquidityUsd: liquidity,
      volumeUsd: volume,
      volumeWindow: p?.volumeWindow ?? null,
      referencePriceUsd: price,
      holderCount,
      transferSample: d?.transferSample ?? null,
    },
  };
}
