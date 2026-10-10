import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ExitRules, RiskConfig } from '../shared/domain';
import { validateRules } from './lib';

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    trade: <><path d="M3 17l5-6 4 3 8-10"/><path d="M15 4h5v5"/><path d="M3 21h18"/></>,
    robot: <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12v2m8-2v2M9 17h6M1 11v5m22-5v5"/></>,
    research: <><path d="M9 3h6m-5 0v7L4 20h16l-6-10V3"/><path d="M7 15h10"/></>,
    review: <><path d="M4 4h16v16H4zM8 8h8M8 12h5M8 16h3"/></>,
    settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="M15 15l5 5"/></>,
    arrow: <path d="M6 12h12m-5-5l5 5-5 5"/>,
    chevron: <path d="M6 9l6 6 6-6"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    close: <path d="M6 6l12 12M18 6L6 18"/>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0113-3l2 7M4 12l2 7a8 8 0 0013-3"/></>,
    shield: <><path d="M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6z"/><path d="M8 12l3 3 5-6"/></>,
    down: <><path d="M12 3v12m-5-5l5 5 5-5M4 17v4h16v-4"/></>,
    up: <><path d="M12 16V4m-5 5l5-5 5 5M4 17v4h16v-4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    pause: <><path d="M8 5v14M16 5v14"/></>,
    play: <path d="M7 4l13 8-13 8z"/>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></>,
    wallet: <><path d="M20 8V5H4v15h16V8H4"/><path d="M20 11h-6v5h6"/></>,
    external: <><path d="M14 3h7v7M21 3L10 14M10 3H3v18h18v-7"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.info}</svg>;
}
export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'green' | 'red' | 'amber' | 'blue' }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function Empty({ title, detail, icon = 'research', action }: { title: string; detail?: string; icon?: string; action?: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={24}/></span><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>; }
export function Stat({ label, value, sub, tone = '' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) { return <div className="stat"><span className="stat-label">{label}</span><strong className={tone}>{value}</strong>{sub && <span className="stat-sub">{sub}</span>}</div>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" onClick={onClose}><section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><Icon name="close"/></button></header>{children}</section></div>;
}
export function RulesEditor({ rules, onChange, compact = false }: { rules: ExitRules; onChange: (rules: ExitRules) => void; compact?: boolean }) {
  const total = rules.targets.reduce((s, t) => s + t.sellOriginalPct, 0);
  const error = validateRules(rules);
  return <div className={`rules-editor ${compact ? 'compact' : ''}`}>
    <div className="section-label"><span>退出规则</span><Badge tone="blue">按原始总仓位</Badge></div>
    <div className="two-fields"><Field label="初始止损 · 跌幅 %"><input type="number" min="0.01" max="99.99" step="0.1" value={rules.stopPct} onChange={e => onChange({ ...rules, stopPct: Number(e.target.value) })}/></Field><Field label="首卖后回撤退出 %"><input type="number" min="0.01" max="99.99" step="0.1" value={rules.trailPct} onChange={e => onChange({ ...rules, trailPct: Number(e.target.value) })}/></Field></div>
    <div className="target-heading"><span>涨幅触发 %</span><span>卖出原仓 %</span></div>
    {rules.targets.map((target, i) => <div className="target-row" key={i}><input aria-label={`第 ${i + 1} 档止盈涨幅`} type="number" min="0.01" step="1" value={target.gainPct} onChange={e => onChange({ ...rules, targets: rules.targets.map((t, j) => j === i ? { ...t, gainPct: Number(e.target.value) } : t) })}/><input aria-label={`第 ${i + 1} 档卖出原仓比例`} type="number" min="0.01" max="100" step="1" value={target.sellOriginalPct} onChange={e => onChange({ ...rules, targets: rules.targets.map((t, j) => j === i ? { ...t, sellOriginalPct: Number(e.target.value) } : t) })}/><button type="button" className="icon-button" aria-label={`删除第 ${i + 1} 档止盈`} onClick={() => onChange({ ...rules, targets: rules.targets.filter((_, j) => j !== i) })}><Icon name="close" size={14}/></button></div>)}
    <button type="button" className="text-button" onClick={() => onChange({ ...rules, targets: [...rules.targets, { gainPct: (rules.targets.at(-1)?.gainPct ?? 0) + 30, sellOriginalPct: Math.max(1, Math.min(25, 100 - total)) }] })} disabled={total >= 100 || rules.targets.length >= 8}><Icon name="plus" size={14}/>添加止盈档位</button>
    <div className={`rule-total ${total > 100 ? 'negative' : ''}`}>合计卖出原仓 {total}% · 未设置止盈的余仓由止损、回撤或时间退出处理</div>
    <Field label="最长持有 · 分钟"><input type="number" min="0.02" step="1" value={Number((rules.maxHoldMs / 60000).toFixed(3))} onChange={e => onChange({ ...rules, maxHoldMs: Number(e.target.value) * 60000 })}/></Field>
    <label className="checkbox"><input type="checkbox" checked={rules.protectBreakeven} onChange={e => onChange({ ...rules, protectBreakeven: e.target.checked })}/>首卖后保护剩余成本（含费用）<span title="后台用剩余仓位扣除卖出费用后的可变现金额，对照该批次剩余成本判断退出；跳空或卖出失败仍可能亏损。"><Icon name="info" size={14}/></span></label>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
export function RiskEditor({ risk, onSave, pending, externalError = '' }: { risk: RiskConfig; onSave: (risk: RiskConfig) => Promise<boolean>; pending: boolean; externalError?: string }) {
  const [draft, setDraft] = useState(risk);
  const [error, setError] = useState('');
  const fields: [keyof RiskConfig, string, string][] = [['riskPct', '单笔计划净损失上限', '% 净值'], ['maxPositionPct', '单次投入上限', '% 净值'], ['maxPositions', '同时持仓上限', '个币'], ['dailyEntries', '每天新开仓上限', '次'], ['maxConsecutiveLosses', '连续净亏停止', '次'], ['dailyLossPct', '当日净亏停止', '% 净值']];
  return <form onSubmit={async e => { e.preventDefault(); if (Object.values(draft).some(v => !Number.isFinite(v) || v <= 0) || draft.riskPct > 100 || draft.maxPositionPct > 100 || draft.dailyLossPct > 100 || [draft.maxPositions, draft.dailyEntries, draft.maxConsecutiveLosses].some(v => !Number.isInteger(v))) { setError('比例须在 0–100% 内，次数和持仓数须为正整数。'); return; } setError(''); await onSave(draft); }}>
    <p className="muted help-text">风险预算包含估计交易费用。首版限制只允许收紧；更新后机器人须重新验证。行情跳空、税费变化或无法卖出时，实际模拟损失可能超过计划值。</p>
    <div className="two-fields">{fields.map(([key, label, unit]) => <Field key={key} label={`${label} · ${unit}`}><input type="number" value={draft[key]} min="0.01" step={['maxPositions', 'dailyEntries', 'maxConsecutiveLosses'].includes(key) ? '1' : '0.1'} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })}/></Field>)}</div>
    {(error || externalError) && <p role="alert" className="inline-error">{error || externalError}</p>}
    <button type="submit" className="button primary full" disabled={pending}>保存虚拟账户风控</button>
  </form>;
}
