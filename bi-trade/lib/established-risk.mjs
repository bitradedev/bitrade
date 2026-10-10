// Exact BSC addresses from PancakeSwap's official default token list.
// This narrow paper-only universe is not a generic exemption for meme tokens.
export const ESTABLISHED_ASSETS = Object.freeze([
  {
    symbol: 'CAKE',
    address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
    pool: '0x0ed7e52944161450477ee417de9cd3a859b14fd0',
    codeHash: '0x21b2b23f1103cfdca4d9dd3ba0480364852b6cc3c71497a1f3f0bd7d4b56264c',
  },
  {
    symbol: 'BTCB',
    address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    pool: '0x61eb789d75a95caa3ff50ed7e47b96c132fec082',
    codeHash: '0x3ad0053f60cb104f6f7e6dcd102b84045e26e444bc334ba254e57bc43497516c',
  },
  {
    symbol: 'ETH',
    address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8',
    pool: '0x74e4716e431f45807dcf19f284c7aa99f18a4fbc',
    codeHash: '0x24d639ec3ab0dfc14d482da65b0dfc3c325351d938d8cfffa4aa47e4ac8f0e65',
  },
]);
export const ESTABLISHED_POLICY = Object.freeze({
  id: 'established-spot-v1',
  minLiquidityUsd: 500000,
  minVolumeUsd: 10000,
  minHolders: 100000,
  minPoolAgeMs: 180 * 86400000,
  maxLargestFloatShare: 0.35,
  maxTopTenFloatShare: 0.9,
});
export const establishedAsset = (token) =>
  ESTABLISHED_ASSETS.find((a) => a.address === String(token).toLowerCase());
const addr = (v) => (typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null);
const num = (v) =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
const uint = (v) => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
export function evaluateEstablishedRisk(
  token,
  { pair, check, holders, proof },
  fetchedAt = Date.now(),
) {
  token = addr(token);
  const asset = establishedAsset(token),
    missing = [],
    blocked = [];
  if (!asset) missing.push('不在成熟外盘的固定合约名单内');
  if (
    pair?.chainId !== 'bsc' ||
    pair?.dexId !== 'pancakeswap' ||
    addr(pair?.baseToken?.address) !== token ||
    addr(pair?.quoteToken?.address) !== '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' ||
    addr(pair?.pairAddress) !== asset?.pool ||
    !pair?.labels?.includes('v2')
  )
    missing.push('独立行情的链、资产或官方池身份未核实');
  if (proof?.codeHash !== asset?.codeHash || addr(proof?.pool) !== asset?.pool)
    blocked.push('合约代码或链上官方工厂池与固定名单不一致');
  if (
    String(check?.chain?.id) !== '56' ||
    String(check?.pair?.chainId) !== '56' ||
    addr(check?.token?.address) !== token ||
    addr(check?.pair?.pair?.address) !== asset?.pool
  )
    missing.push('买卖检测的链、合约或交易池身份未核实');
  if (check?.simulationSuccess !== true || typeof check?.honeypotResult?.isHoneypot !== 'boolean')
    missing.push('真实买卖检测尚未成功');
  if (check?.honeypotResult?.isHoneypot === true) blocked.push('买卖检测报告貔貅或禁止卖出');
  for (const field of ['buyTax', 'sellTax', 'transferTax']) {
    const value = num(check?.simulationResult?.[field]);
    if (value === null || value < 0) missing.push('买卖或转账税字段缺失');
    else if (value !== 0) blocked.push('成熟外盘模拟路径仅支持已检出的零转账税代币');
  }
  const contract = check?.contractCode;
  if (
    contract?.openSource !== true ||
    contract?.rootOpenSource !== true ||
    contract?.isProxy !== false ||
    contract?.hasProxyCalls !== false
  )
    missing.push('开源且不使用代理的合约身份未核实');
  const level = num(check?.summary?.riskLevel);
  if (level === null || level < 0) missing.push('安全检测风险等级未返回');
  else if (level >= 20) blocked.push('买卖检测风险等级过高');
  if ((check?.summary?.flags ?? []).some((f) => num(f.severityIndex) >= 10))
    blocked.push('买卖检测存在中高等级风险标记');
  const liquidity = num(pair?.liquidity?.usd),
    volume = num(pair?.volume?.h24),
    price = num(pair?.priceUsd),
    count = num(check?.token?.totalHolders),
    created = num(check?.pair?.createdAtTimestamp);
  if (!(liquidity >= ESTABLISHED_POLICY.minLiquidityUsd))
    blocked.push('成熟池流动性低于50万美元或未取得');
  if (!(volume >= ESTABLISHED_POLICY.minVolumeUsd))
    blocked.push('该官方池24小时成交量低于1万美元或未取得');
  if (!(price > 0)) missing.push('独立美元参考价格缺失');
  if (!(count >= ESTABLISHED_POLICY.minHolders)) blocked.push('成熟资产持币地址数不足10万或未取得');
  if (!(created > 0) || fetchedAt - created * 1000 < ESTABLISHED_POLICY.minPoolAgeMs)
    blocked.push('该官方池运行时间不足180天或未取得');
  const supply = uint(holders?.totalSupply),
    chainSupply = uint(proof?.totalSupply),
    burn = uint(proof?.burnBalance),
    pool = uint(proof?.poolBalance),
    rows = [],
    seen = new Set();
  if (!supply || !chainSupply || burn === null || pool === null || burn + pool >= chainSupply)
    missing.push('供应量、销毁量或池内持仓未核实');
  if (supply && chainSupply && Math.abs(Number(supply) / Number(chainSupply) - 1) > 0.01)
    missing.push('持仓数据与链上供应量不一致');
  for (const h of Array.isArray(holders?.holders) ? holders.holders : []) {
    const id = addr(h.address),
      balance = uint(h.balance);
    if (!id || balance === null || seen.has(id) || typeof h.isContract !== 'boolean') {
      missing.push('持仓地址、余额或合约类型未核实');
      continue;
    }
    seen.add(id);
    rows.push({ address: id, balance });
  }
  if (rows.length < 10 || !supply || rows.reduce((n, h) => n + h.balance, 0n) > supply)
    missing.push('前列持仓列表缺失或总量不一致');
  const normal = rows.filter(
    (h) =>
      ![
        '0x0000000000000000000000000000000000000000',
        '0x000000000000000000000000000000000000dead',
        asset?.pool,
      ].includes(h.address),
  );
  const float = chainSupply && burn !== null && pool !== null ? chainSupply - burn - pool : 0n;
  const largest =
    float > 0n && normal.length
      ? Math.max(...normal.map((h) => Number(h.balance) / Number(float)))
      : null;
  const topTen =
    float > 0n
      ? normal
          .sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0))
          .slice(0, 10)
          .reduce((n, h) => n + Number(h.balance) / Number(float), 0)
      : null;
  if (largest === null || topTen === null) missing.push('持仓集中度未核实');
  if (
    largest > ESTABLISHED_POLICY.maxLargestFloatShare ||
    topTen > ESTABLISHED_POLICY.maxTopTenFloatShare
  )
    blocked.push('成熟资产的可流通持仓集中度超过筛查上限');
  const warnings = [
    '成熟外盘限范围筛查；捆绑钱包、老鼠仓和同源资金未取得，不能据此判断没有关联钱包。',
    'BTCB/ETH 存在托管发行风险，CAKE 存在治理与增发风险；当前仅使用虚拟资金。',
  ];
  const state = blocked.length ? 'blocked' : missing.length ? 'unknown' : 'screened-limited';
  return {
    id: token,
    token,
    chain: 'bsc',
    source: 'BSC RPC · DEX Screener · Honeypot.is',
    policy: ESTABLISHED_POLICY.id,
    policyVersion: 2,
    fetchedAt,
    state,
    buyAllowed: state === 'screened-limited',
    reasons: [...new Set([...blocked, ...missing])],
    warnings,
    metrics: {
      poolSupplyShare: chainSupply && pool !== null ? Number(pool) / Number(chainSupply) : null,
      burnSupplyShare: chainSupply && burn !== null ? Number(burn) / Number(chainSupply) : null,
      largestObservedFloatShare: largest,
      topTenObservedFloatShare: topTen,
      observedFloatCoverage: null,
      bundlerObservedFloatShare: null,
      bundlerVolumeShare: null,
      ratObservedFloatShare: null,
      linkedFunding: null,
      liquidityUsd: liquidity,
      volumeUsd: volume,
      referencePriceUsd: price,
      holderCount: count,
      honeypot: check?.honeypotResult?.isHoneypot ?? null,
      blacklist: null,
      buyTaxPct: num(check?.simulationResult?.buyTax),
      sellTaxPct: num(check?.simulationResult?.sellTax),
    },
  };
}
