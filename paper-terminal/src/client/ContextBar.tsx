import { memo, useEffect, useMemo, useState } from 'react';
import type { AppState, Chain } from '../shared/domain';
import type { Connection } from './useTerminal';
import { money, timestampMs } from './lib';
import { Icon } from './ui';

function useExpired(at: number | null) {
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  const expired = at !== null && (expiredAt === at || Date.now() - timestampMs(at) > 30000);
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setExpiredAt(at), Math.max(0, timestampMs(at) + 30001 - Date.now()));
    return () => clearTimeout(timer);
  }, [at]);
  return expired;
}
export const StateExpiryWarning = memo(function StateExpiryWarning({ at }: { at: number | null }) {
  const stale = useExpired(at);
  return stale ? <div className="global-alert warning"><Icon name="clock" size={16}/><span>显示的是上次收到的状态。请检查本机后台；当前页面数据不代表最新成交结果。</span></div> : null;
});
export const ContextBar = memo(function ContextBar({ state, connection, chain, onChain, refresh, openRisk }: {
  state: AppState | null; connection: Connection; chain: Chain; onChain: (chain: Chain) => void; refresh: () => Promise<void>; openRisk: () => void;
}) {
  const stale = useExpired(state?.at ?? null);
  const trialIds = useMemo(() => new Set(state?.strategies.filter(s => s.mode === 'experiment').map(s => s.accountId) ?? []), [state?.strategies]);
  const accounts = useMemo(() => state?.accounts.filter(a => a.kind !== 'research' || trialIds.has(a.id)) ?? [], [state?.accounts, trialIds]);
  const equity = useMemo(() => accounts.reduce((sum, a) => sum + a.conservativeEquityUsd, 0), [accounts]);
  return <div className="context-bar"><div className="chain-selector" role="group" aria-label="选择网络"><button className={chain === 'bsc' ? 'active' : ''} onClick={() => onChain('bsc')}><span className="chain-symbol bsc-symbol">◆</span>BNB Chain</button><button className={chain === 'robinhood' ? 'active' : ''} onClick={() => onChain('robinhood')}><span className="chain-symbol robin-symbol">↗</span>Robinhood</button></div><div className="connection-label"><span className={`status-dot ${connection === 'live' && !stale ? 'green' : 'amber'}`}/>{stale ? '状态更新过期' : connection === 'live' ? '本机服务已连接' : connection === 'connecting' ? '连接本机服务…' : connection === 'reconnecting' ? '实时连接重试中' : '本机服务未连接'}<button className="icon-button" aria-label="重新读取状态" onClick={() => void refresh()}><Icon name="refresh" size={13}/></button></div><div className="context-summary"><span className="independent-total" title="这是独立账户的保守净值之和，不能作为一个账户的可用资金。"><span>独立账本合计 <b>{state ? money(equity) : '—'}</b></span><small>{state ? `${accounts.filter(a => a.kind === 'manual').length} 个人工 + ${accounts.filter(a => a.kind === 'bot').length} 个机器人${trialIds.size ? ' + ' + trialIds.size + ' 个试运行' : ''} · 各自记账，资金不互通` : '各账户独立使用虚拟资金'}</small></span><span className="desktop-only">单笔计划风险 <b>{state ? state.risk.riskPct + '%' : '—'}</b></span><button className="text-button desktop-only" onClick={openRisk} disabled={!state}><Icon name="shield" size={14}/>风控</button></div></div>;
});
