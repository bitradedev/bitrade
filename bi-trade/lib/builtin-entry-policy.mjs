import { fail, fields } from './database-core.mjs';

export const BUILTIN_ENTRY_POLICY = Object.freeze({
  version: 1,
  minVolume5mUsd: 3000,
  maxAgeMs: 15000,
});
export function volumeEligibility(v, now = Date.now()) {
  const boundaryAt = v?.boundaryAt ?? v?.at;
  const valid =
    v?.windowMs === 300000 &&
    v?.quality === 'observed-lower-bound' &&
    Number.isFinite(v.usd) &&
    v.usd >= 0 &&
    Number.isFinite(v.at) &&
    now >= v.at &&
    now - v.at < BUILTIN_ENTRY_POLICY.maxAgeMs &&
    Number.isFinite(boundaryAt) &&
    boundaryAt >= v.at &&
    boundaryAt <= now &&
    Number.isFinite(v.fromTime) &&
    v.fromTime >= boundaryAt - 300000 &&
    Number.isFinite(v.toTime) &&
    v.toTime >= now - BUILTIN_ENTRY_POLICY.maxAgeMs &&
    v.toTime <= now &&
    v.fromTime <= v.toTime;
  return {
    allowed: valid && v.usd >= BUILTIN_ENTRY_POLICY.minVolume5mUsd,
    reason: !valid
      ? '最近5分钟成交量尚未核实，暂不开新仓。'
      : v.usd < BUILTIN_ENTRY_POLICY.minVolume5mUsd
        ? '最近5分钟成交量尚未核实达到3,000美元，暂不开新仓。'
        : null,
  };
}
export function assertVolume5m(v, now = Date.now()) {
  const result = volumeEligibility(v, now);
  if (!result.allowed) throw fail(result.reason, 409);
}
export function validateNarrative(n, evidence) {
  if (!n) throw fail('本次尚未完成叙事判断，等待重新评估。', 409);
  fields(n, ['verdict', 'thesis', 'catalyst', 'risks', 'evidenceIds']);
  if (
    !['supported', 'speculative', 'unknown', 'contradicted'].includes(n.verdict) ||
    !['thesis', 'risks'].every(
      (k) => typeof n[k] === 'string' && n[k].trim() && n[k].length <= 400,
    ) ||
    !(n.catalyst === null || (typeof n.catalyst === 'string' && n.catalyst.length <= 240)) ||
    !Array.isArray(n.evidenceIds) ||
    n.evidenceIds.length > 8 ||
    n.evidenceIds.some(
      (id) => typeof id !== 'string' || !evidence?.sources?.some((s) => s.id === id),
    ) ||
    new Set(n.evidenceIds).size !== n.evidenceIds.length ||
    (n.verdict !== 'unknown' && !n.evidenceIds.length) ||
    (n.verdict === 'supported' &&
      !n.evidenceIds.some((id) =>
        evidence.sources.some((s) => s.id === id && s.independent === true),
      ))
  )
    throw fail('叙事判断缺少对应资料或把项目自述当成已核实事实，等待重新评估。', 409);
  return n;
}
