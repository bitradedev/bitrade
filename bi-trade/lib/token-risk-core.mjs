const unwrap = (data) => data?.data ?? data;
import { fail } from './database-core.mjs';

const numeric = (v) =>
  (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
const ratio = (v) =>
  numeric(v) !== null && numeric(v) >= 0 && numeric(v) <= 1 ? numeric(v) : null;
const positive = (v) => (numeric(v) !== null && numeric(v) > 0 ? numeric(v) : null);
const flag = (v) =>
  v === true || v === 1 || v === '1' ? true : v === false || v === 0 || v === '0' ? false : null;
const address = (v) =>
  typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v) ? v.toLowerCase() : null;
const tags = (h) => (Array.isArray(h.maker_token_tags) ? h.maker_token_tags : []);
const sum = (rows) => rows.reduce((n, h) => n + h.share, 0);
export const RISK_POLICY = {
  version: 1,
  maxAgeMs: 120000,
  minFloatShare: 0.02,
  minObservedFloatCoverage: 0.995,
  maxBundlerFloatShare: 0.3,
  maxBundlerVolumeShare: 0.3,
  maxRatFloatShare: 0.05,
  maxLargestFloatShare: 0.1,
  maxLinkedFloatShare: 0.25,
};
export function currentRiskEvidence(report, now = Date.now()) {
  return (
    Boolean(report) &&
    Number.isFinite(report.fetchedAt) &&
    now >= report.fetchedAt &&
    now - report.fetchedAt <= RISK_POLICY.maxAgeMs
  );
}

// A screening report, not a guarantee or a rug probability. Missing data never passes.
export function evaluateTokenRisk(token, { info, holders, security }, fetchedAt = Date.now()) {
  token = address(token);
  const missing = [],
    blocked = [];
  if (!token || address(info?.address) !== token || address(security?.address) !== token)
    missing.push('风险资料的合约地址未核实');
  const list = Array.isArray(holders?.list) ? holders.list : [];
  if (!list.length) missing.push('持仓列表缺失');
  const seen = new Set(),
    rows = [];
  for (const h of list) {
    const id = address(h.address),
      share = ratio(h.amount_percentage),
      kind = Number(h.addr_type);
    if (
      !id ||
      share === null ||
      ![0, 1, 2].includes(kind) ||
      h.addr_type === null ||
      h.addr_type === undefined ||
      seen.has(id)
    ) {
      missing.push('持仓地址、占比或地址类型未核实');
      continue;
    }
    seen.add(id);
    if (share > 0) rows.push({ ...h, address: id, share, kind });
  }
  const pools = sum(rows.filter((h) => h.kind === 2 && h.address !== token)),
    burn = sum(rows.filter((h) => h.kind === 1 && h.address !== token)),
    coverage = sum(rows),
    float = 1 - pools - burn;
  if (coverage > 1.00001 || float <= 0 || float < RISK_POLICY.minFloatShare)
    missing.push('池外可交易筹码不足2%，不能据此判定持仓结构安全');
  const normal = rows.filter((h) => h.kind === 0 && h.address !== token),
    selfHeld = sum(rows.filter((h) => h.address === token));
  const observedFloat = normal.reduce((n, h) => n + h.share, 0) + selfHeld,
    observedCoverage = float > 0 ? Math.min(1, observedFloat / float) : null;
  if (float >= RISK_POLICY.minFloatShare && observedCoverage < RISK_POLICY.minObservedFloatCoverage)
    missing.push('前100持仓未覆盖足够可交易筹码，捆绑占比仍有未知部分');
  if (normal.some((h) => !Array.isArray(h.maker_token_tags))) missing.push('持仓风险标签未返回');
  const bundleVolume = ratio(info?.stat?.top_bundler_trader_percentage);
  if (bundleVolume === null) missing.push('捆绑交易量占比缺失');
  const liquidity = positive(info?.liquidity),
    referencePrice = positive(info?.price?.price);
  if (liquidity === null) missing.push('池流动性未核实');
  if (referencePrice === null) missing.push('独立价格参考未核实');
  const honeypot = flag(security?.is_honeypot),
    blacklist = flag(security?.is_blacklist);
  if (honeypot === null || blacklist === null) missing.push('合约限制交易字段未核实');
  if (honeypot === true || flag(security?.can_not_sell) === true)
    blocked.push('存在禁止卖出或貔貅标记');
  if (blacklist === true) blocked.push('存在黑名单能力标记');
  const bundlers = normal.filter((h) => tags(h).includes('bundler')),
    rats = normal.filter((h) => tags(h).includes('rat_trader'));
  const assessable = float >= RISK_POLICY.minFloatShare,
    bundleFloat = assessable ? sum(bundlers) / float : null,
    ratFloat = assessable ? sum(rats) / float : null,
    largestFloat =
      assessable && normal.length ? Math.max(...normal.map((h) => h.share)) / float : null;
  if (bundleVolume !== null && bundleVolume > RISK_POLICY.maxBundlerVolumeShare)
    blocked.push('捆绑交易量占比超过30%的筛查上限');
  if (bundleFloat !== null && bundleFloat > RISK_POLICY.maxBundlerFloatShare)
    blocked.push('带捆绑标签的钱包持有超过30%的可交易筹码');
  if (ratFloat !== null && ratFloat > RISK_POLICY.maxRatFloatShare)
    blocked.push('老鼠仓标签筹码超过5%的可交易筹码');
  if (largestFloat !== null && largestFloat > RISK_POLICY.maxLargestFloatShare)
    blocked.push('最大普通钱包持有超过10%的可交易筹码');
  const creator = address(info?.dev?.creator_address),
    groups = new Map();
  for (const h of normal) {
    const f = h.native_transfer,
      from = address(f?.from_address);
    if (!from) continue;
    if (creator && from === creator) blocked.push('创建者曾为当前持币钱包提供资金');
    // A common exchange withdrawal address is not evidence of common control.
    if (typeof f.name === 'string' && /binance|coinbase|okx|kucoin|bybit/i.test(f.name)) continue;
    const g = groups.get(from) ?? [];
    g.push(h);
    groups.set(from, g);
  }
  const linked = [...groups]
    .filter(([, wallets]) => wallets.length >= 2)
    .map(([from, wallets]) => ({
      from,
      walletCount: wallets.length,
      totalSupplyShare: sum(wallets),
      floatShare: assessable ? sum(wallets) / float : null,
    }));
  if (linked.some((g) => g.floatShare !== null && g.floatShare > RISK_POLICY.maxLinkedFloatShare))
    blocked.push('同源资金样本持有超过25%的可交易筹码，需进一步核查');
  const reasons = [...new Set([...blocked, ...missing])],
    state = blocked.length ? 'blocked' : missing.length ? 'unknown' : 'screened';
  return {
    id: token,
    token,
    chain: 'bsc',
    source: 'GMGN CLI · token info/holders/security',
    fetchedAt,
    policyVersion: RISK_POLICY.version,
    state,
    buyAllowed: state === 'screened',
    reasons,
    metrics: {
      poolSupplyShare: pools,
      burnSupplyShare: burn,
      tradeableFloatShare: float,
      observedFloatCoverage: observedCoverage,
      bundlerObservedWallets: bundlers.length,
      bundlerObservedTotalSupplyShare: sum(bundlers),
      bundlerObservedFloatShare: bundleFloat,
      bundlerVolumeShare: bundleVolume,
      largestObservedFloatShare: largestFloat,
      ratObservedFloatShare: ratFloat,
      linkedFunding: linked,
      liquidityUsd: liquidity,
      referencePriceUsd: referencePrice,
      honeypot,
      blacklist,
    },
  };
}

export class TokenRiskGuard {
  constructor(store, { source, now = () => Date.now(), maxTokensPerTick = 4 } = {}) {
    if (!source) throw Error('A read-only risk source is required');
    Object.assign(this, { store, source, now, maxTokensPerTick });
    this.pending = new Map();
    this.stopped = false;
    this.refreshAt = 0;
    this.task = null;
  }
  snapshot(token, marketPrice = null) {
    token = address(token);
    const saved = token ? this.store.get('token-risk-reports', token) : null;
    if (!saved)
      return {
        token,
        state: 'unknown',
        buyAllowed: false,
        reasons: ['尚未取得持仓和捆绑风险资料'],
        metrics: null,
      };
    if (!Number.isFinite(saved.fetchedAt))
      return {
        ...saved,
        state: 'unknown',
        buyAllowed: false,
        reasons: ['持仓风险资料时间未核实，需要重新核查'],
      };
    if (!currentRiskEvidence(saved, this.now()))
      return {
        ...saved,
        state: 'unknown',
        buyAllowed: false,
        reasons: ['持仓风险资料已过期，需要重新核查'],
      };
    const reference = saved.metrics?.referencePriceUsd,
      gap =
        positive(marketPrice) && positive(reference)
          ? Math.abs(marketPrice / reference - 1) * 100
          : null;
    // Price movement since a screening sample is context for the AI. Exact
    // current execution quotes govern fills; an old price gap is not a veto.
    return { ...saved, priceGapPct: gap };
  }
  refresh(token) {
    token = address(token);
    if (!token || this.stopped) return Promise.resolve(this.snapshot(token));
    const cached = this.store.get('token-risk-reports', token);
    if (
      cached &&
      currentRiskEvidence(cached, this.now()) &&
      this.now() - cached.fetchedAt < RISK_POLICY.maxAgeMs
    )
      return Promise.resolve(this.snapshot(token));
    if (this.pending.has(token)) return this.pending.get(token);
    const startedAt = this.now(),
      task = (async () => {
        try {
          const provided = await this.source.riskReport?.(token);
          if (provided) {
            if (
              provided.token !== token ||
              provided.chain !== 'bsc' ||
              !Number.isFinite(provided.fetchedAt) ||
              provided.fetchedAt > this.now()
            )
              throw Error('风险报告身份或时间无效');
            if (!this.stopped) this.store.put('token-risk-reports', provided);
            return this.snapshot(token);
          }
          const responses = [
              await this.source.info('bsc', token),
              await this.source.holders('bsc', token),
              await this.source.security('bsc', token),
            ],
            [info, holders, security] = responses.map(unwrap);
          const capturedAt = Math.min(
            startedAt,
            ...responses.map((r) =>
              Number.isFinite(r?._bitradeReadAt) && r._bitradeReadAt > 0
                ? r._bitradeReadAt
                : startedAt,
            ),
          );
          const report = evaluateTokenRisk(token, { info, holders, security }, capturedAt);
          report.source = this.source.label?.(token) ?? report.source;
          if (!this.stopped) this.store.put('token-risk-reports', report);
        } catch (error) {
          // A local round has no new evidence when its request budget runs out.
          // Keep the prior report and its original age, so the next round can
          // retry instead of caching this scheduling failure for two minutes.
          if (error?.code === 'CF_SUBREQUEST_BUDGET') return this.snapshot(token);
          if (!this.stopped)
            this.store.put('token-risk-reports', {
              id: token,
              token,
              chain: 'bsc',
              source: this.source.label?.(token) ?? 'GMGN CLI',
              fetchedAt: this.now(),
              state: 'unknown',
              buyAllowed: false,
              reasons: ['持仓、捆绑或安全资料读取失败；暂不允许买入'],
              metrics: null,
            });
        }
        return this.snapshot(token);
      })().finally(() => this.pending.delete(token));
    this.pending.set(token, task);
    return task;
  }
  tick(tokens) {
    if (this.stopped || this.task || this.now() - this.refreshAt < 15000) return this.task;
    this.refreshAt = this.now();
    // One bounded background batch shares the existing global CLI rate budget.
    const todo = [...new Set(tokens.map(address).filter(Boolean))]
      .filter(
        (t) =>
          !this.store.get('token-risk-reports', t) ||
          this.now() - this.store.get('token-risk-reports', t).fetchedAt >= RISK_POLICY.maxAgeMs,
      )
      .slice(0, this.maxTokensPerTick);
    this.task = (async () => {
      for (const token of todo) {
        if (this.stopped) break;
        await this.refresh(token);
      }
    })().finally(() => {
      this.task = null;
    });
    return this.task;
  }
  async assertBuy(token, { sizeUsd, marketPrice = null, refresh = true } = {}) {
    if (refresh) await this.refresh(token);
    const report = this.snapshot(token, marketPrice);
    if (!report.buyAllowed) throw fail('开仓风险检查未通过：' + report.reasons.join('；'), 409);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || !positive(report.metrics?.liquidityUsd))
      throw fail('买入金额或可交易流动性尚未核实，暂不允许买入', 409);
    return report;
  }
  async close() {
    this.stopped = true;
    this.source.close?.();
    await Promise.allSettled([...this.pending.values()]);
    await this.task;
  }
}
