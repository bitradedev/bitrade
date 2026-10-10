import type { Account, AppState, Candle, ExitRules, Fill, Position } from '../shared/domain';

export const CHAIN_NAMES = { bsc: 'BNB Chain', robinhood: 'Robinhood' } as const;
export const ORDER_NAMES: Record<string, string> = { waiting: '等待触发', queued: '等待新区块', quoting: '正在报价', filled: '已成交', partial: '部分成交', failed: '失败', cancelled: '已取消' };
export const QUALITY_NAMES = { verified: '行情已核实', estimated: '费用估算', unavailable: '尚不能报价' } as const;
export const RESEARCH_NAMES: Record<string, string> = { collecting: '采集样本', training: '训练 / 验证', forward: '实时检验', passed: '检验通过', failed: '未达标', error: '执行异常' };
const amountFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const priceFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 });
const wholeQuantityFormat = new Intl.NumberFormat('en-US');
const timeFormatOptions: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
const timeFormat = new Intl.DateTimeFormat('zh-CN', timeFormatOptions);
const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', { ...timeFormatOptions, month: '2-digit', day: '2-digit' });
export function money(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${signed && value > 0 ? '+' : value < 0 ? '−' : ''}$${amountFormat.format(Math.abs(value))}`;
}
export function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  return '$' + priceFormat.format(value);
}
export function pct(value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
export function shortAddress(value: string) { return value.length > 15 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value; }
export function validAddress(value: string) { return /^0x[\da-f]{40}$/i.test(value.trim()); }
export function timestampMs(value: number) { return value < 1e12 ? value * 1000 : value; }
export function timeText(value: number | null | undefined, date = false): string {
  if (!value) return '—';
  return (date ? dateTimeFormat : timeFormat).format(timestampMs(value));
}
export function rawQuantity(raw: string | null | undefined, decimals = 18): string {
  if (!raw || !/^\d+$/.test(raw)) return '—';
  const text = raw.padStart(decimals + 1, '0');
  const whole = decimals ? text.slice(0, -decimals) : text;
  const fraction = decimals ? text.slice(-decimals).slice(0, 6).replace(/0+$/, '') : '';
  return wholeQuantityFormat.format(Number(whole)) + (fraction ? '.' + fraction : '');
}
/** Percentages always refer to this lot's frozen original quantity. */
export function originalSellQuantity(position: Pick<Position, 'originalRaw' | 'remainingRaw'>, percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return '0';
  const requested = BigInt(position.originalRaw) * BigInt(Math.round(percent * 100)) / 10000n;
  const remaining = BigInt(position.remainingRaw);
  return (requested < remaining ? requested : remaining).toString();
}
export function validateRules(rules: ExitRules): string | null {
  if (!Number.isFinite(rules.stopPct) || rules.stopPct <= 0 || rules.stopPct >= 100) return '止损跌幅须大于 0%，小于 100%。';
  if (!Number.isFinite(rules.trailPct) || rules.trailPct <= 0 || rules.trailPct >= 100) return '回撤退出须大于 0%，小于 100%。';
  if (!Number.isFinite(rules.maxHoldMs) || rules.maxHoldMs < 1000) return '最长持有时间至少 1 秒。';
  if (rules.targets.some(t => !Number.isFinite(t.gainPct) || t.gainPct <= 0 || !Number.isFinite(t.sellOriginalPct) || t.sellOriginalPct <= 0 || t.sellOriginalPct > 100)) return '每档止盈的涨幅和卖出比例都须大于 0，卖出比例不能超过 100%。';
  if (rules.targets.reduce((n, t) => n + t.sellOriginalPct, 0) > 100 + 1e-9) return '各档卖出原仓比例合计不能超过 100%。';
  if (new Set(rules.targets.map(t => t.gainPct)).size !== rules.targets.length) return '止盈涨幅不能重复。';
  return null;
}
export function normalizeCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    const time = Math.floor(timestampMs(c.time) / 1000);
    if (time > 0 && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close) && c.low >= 0 && c.volume >= 0) byTime.set(time, { ...c, time });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
export function totalFillFees(fill: Fill): number {
  const f = fill.fees;
  return f.gasUsd + f.approvalUsd + f.protocolUsd + f.taxUsd + f.conversionUsd;
}
export function accountReturn(account: Account) { return account.initialCapitalUsd > 0 ? (account.conservativeEquityUsd / account.initialCapitalUsd - 1) * 100 : 0; }
export function accountOptions(state: AppState, chain: Account['chain'], manualOnly = false) { return state.accounts.filter(a => a.chain === chain && (!manualOnly || a.kind === 'manual')); }
export function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function extractError(value: unknown, fallback = '操作失败，请稍后重试。'): string { return typeof object(value).error === 'string' ? String(object(value).error) : fallback; }
export function feeLabel(quality: string, included: boolean) { return `${quality === 'verified' ? '已核实' : quality === 'estimated' ? '费用含估计' : '费用不可用'} · ${included ? '输出已扣协议 / 税费' : '按账本计费'}`; }
export function savedEquityPoints(health: Record<string, unknown>, accountId: string): { time: number; value: number }[] {
  const rows = object(health.equity)[accountId];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => { const r = object(row); return typeof r.at === 'number' && typeof r.conservative === 'number' && Number.isFinite(r.at) && r.at > 0 && Number.isFinite(r.conservative) ? [{ time: Math.floor(timestampMs(r.at) / 1000), value: r.conservative }] : []; });
}
export function researchReason(reason: string): string {
  const labels: Record<string, string> = {
    'Waiting for authoritative samples': '等待可核实的完整样本。',
    'Window overlaps a previously sealed final test; no reused test tuning': '研究窗口与已封存检验重叠，不能重复用于调参。',
    'Need 100 complete authoritative training rounds; candles, missing quotes and fees cannot promote': '训练需要至少 100 个完整且可核实的回合；缺少报价或费用的 K 线不能用于启用策略。',
    'No validation candidate passed; retain every attempt and wait for new data': '所有验证候选均未达标；保留每次尝试，等待新数据。',
    'Parameters sealed; waiting for seven NEW days of forward paper quotes': '参数已封存，等待 7 天全新的实时模拟报价。',
    'Seven NEW forward days have not completed; no early promotion': '7 天全新实时检验尚未结束，不能提前启用。',
    'All sealed forward sample, net, PF, drawdown and clustered bootstrap gates passed': '封存后的样本、净收益、盈亏比、回撤及代币聚类检验全部通过。',
    'Forward sample/quality/performance/bootstrap gate failed; preserve this test and wait for NEW data': '实时检验未通过样本、质量、收益或重采样门槛；保留本轮结果，等待新行情。',
    'Forward evidence was archived before parameter freeze': '检验资料早于参数封存，不能作为独立实时检验。',
    'training only': '仅完成训练，未进入前 5 名验证候选。',
    'validation eligible': '验证达标，等待独立实时检验。',
    'validation sample/quality/performance gate failed': '验证的样本、质量或收益门槛未通过。',
    'Separate losing baseline; never eligible for selection': '单独保留的亏损基准，不参与参数选择。',
  };
  return labels[reason] ?? reason;
}
