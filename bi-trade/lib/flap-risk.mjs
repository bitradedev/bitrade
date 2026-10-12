export const FLAP_POLICY = 'bsc-flap-paper-v1';
export function evaluateFlapRisk(token, e, at = Date.now()) {
  const missing = [],
    blocked = [],
    s = e?.state,
    m = e?.market;
  if (
    e?.originVerified !== true ||
    e?.token !== token ||
    !/^0x[0-9a-f]{64}$/i.test(e?.codeHash ?? '')
  )
    missing.push('Flap Portal 发行身份未核实');
  if (![1, 4].includes(Number(s?.status))) blocked.push('Flap 当前阶段不允许双向交易');
  if (!/^0x0{64}$/i.test(s?.extensionID ?? '')) blocked.push('Flap 扩展合约未核实');
  for (const k of ['buyTaxRate', 'sellTaxRate']) {
    const n = Number(s?.[k]);
    if (!Number.isInteger(n) || n < 0 || n >= 10000) missing.push('Flap 买卖税无效');
  }
  for (const k of ['buyFeeBps', 'sellFeeBps'])
    if (!Number.isInteger(Number(e?.[k])) || Number(e[k]) < 0 || Number(e[k]) >= 10000)
      missing.push('Flap 协议费字段未核实');
  if (
    !Number.isInteger(Number(s?.tokenVersion)) ||
    Number(s.tokenVersion) < 0 ||
    Number(s.tokenVersion) > 7
  )
    missing.push('Flap 新版代币模板尚未核实');
  if (
    Number(e?.buyFeeBps) + Number(s?.buyTaxRate) >= 10000 ||
    Number(e?.sellFeeBps) + Number(s?.sellTaxRate) >= 10000
  )
    blocked.push('协议费与税费耗尽交易金额');
  if (
    Number(s?.status) === 1 &&
    !(
      Number(s?.r) > 0 &&
      Number(s?.k) > 0 &&
      Number(s?.dexSupplyThresh) > Number(s?.circulatingSupply)
    )
  )
    missing.push('Flap 曲线参数与可交易容量未核实');
  if (e?.decimals !== 18) missing.push('Flap 曲线代币精度未支持');
  if (!(e?.reserveUsd > 0) || !(Number(e?.sellQuote) > 0))
    missing.push('曲线真实储备或卖出报价未核实');
  if (m?.quality !== 'verified' || !(m?.priceUsd > 0) || !Number.isFinite(at))
    missing.push('Flap 当前价格与报价币兑换未核实');
  if (e?.holders?.available) {
    if (e.holders.largestSupplyShare > 0.2 || e.holders.topTenSupplyShare > 0.7)
      blocked.push('观测到明显高集中度持仓');
    if (e.holders.clusters.some((g) => g.circulatingShare > 0.25))
      blocked.push('同一交易向多个当前持币地址分发超过流通量25%，存在关联持仓风险');
  }
  const state = blocked.length ? 'blocked' : missing.length ? 'unknown' : 'screened-limited';
  return {
    id: token,
    token,
    chain: 'bsc',
    source: 'Flap Portal · BSC RPC',
    policy: FLAP_POLICY,
    policyVersion: 2,
    fetchedAt: at,
    state,
    buyAllowed: state === 'screened-limited',
    reasons: [...new Set([...blocked, ...missing])],
    warnings: [
      '新币模拟使用发行身份、曲线储备与净卖出报价；不要求成熟币的全天成交量和持币人数。',
      '完整捆绑、同源资金、黑名单和合约审计资料未知；报价成功不代表已完成账户授权或保证实际可卖出。',
      ...(e?.holders?.available
        ? ['集中度与同交易分发仅按已验证发行区块起的转账记录计算；不能认定这些钱包属于同一人。']
        : ['持仓集中度资料未知。']),
      ...(m?.quoteProofMode === 'rpc-sequential-transfers'
        ? [
            '报价资产用指定数量与收款地址的下一块连续转账模拟补证；代理、发行方控制、冻结和审计仍可能未知，未验证真实账户资金、签名、授权或整笔swap。',
          ]
        : []),
    ],
    metrics: {
      liquidityUsd: e?.reserveUsd ?? null,
      liquidityKind: Number(s?.status) === 1 ? 'curve-reserve' : 'pool-quote-reserve',
      executionQuality:
        m?.quoteProofMode === 'rpc-sequential-transfers' ||
        (Number(s?.status) === 4 && (Number(s?.buyTaxRate) > 0 || Number(s?.sellTaxRate) > 0))
          ? 'estimated'
          : 'verified-quote',
      referencePriceUsd: m?.priceUsd ?? null,
      buyTaxPct: Number(s?.buyTaxRate) / 100,
      sellTaxPct: Number(s?.sellTaxRate) / 100,
      progressPct: Number(s?.progress) / 1e16,
      holderCount: e?.holders?.available ? e.holders.holderCount : null,
      volumeUsd: null,
      honeypot: null,
      blacklist: null,
      linkedFunding: null,
      bundlerObservedFloatShare: null,
      largestObservedFloatShare: null,
      topTenObservedFloatShare: null,
      largestObservedTotalSupplyShare: e?.holders?.available ? e.holders.largestSupplyShare : null,
      holderSample: e?.holders ?? null,
    },
  };
}
