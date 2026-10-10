import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chain, Market } from '../shared/domain';
import { backupDatabase, restoreDatabase } from './api';
import { CHAIN_NAMES, money, timestampMs } from './lib';
import { useTerminal } from './useTerminal';
import type { TerminalActions } from './useTerminal';
import { Badge, Empty, Icon, Modal, RiskEditor } from './ui';
import { Trading, rememberTradingMarket } from './Trading';
import { Scanner } from './Scanner';
import { Robots } from './Robots';
import { Research } from './Research';
import { EquityObservationProvider, ObservedReview } from './Review';
import { ContextBar, StateExpiryWarning } from './ContextBar';

type Page = 'scanner' | 'trading' | 'robots' | 'research' | 'review';
const pages: { id: Page; name: string; icon: string }[] = [{ id: 'scanner', name: '扫链', icon: 'search' }, { id: 'trading', name: '模拟交易', icon: 'trade' }, { id: 'robots', name: '量化机器人', icon: 'robot' }, { id: 'research', name: '策略研究', icon: 'research' }, { id: 'review', name: '交易复盘', icon: 'review' }];
export default function App() {
  const actions = useTerminal(); const { state, connection, error, notice } = actions;
  const [page, setPage] = useState<Page>('trading');
  const [openedMarket, setOpenedMarket] = useState<Market | null>(null);
  const [chain, setChain] = useState<Chain>('bsc');
  const [settings, setSettings] = useState<'risk' | 'data' | null>(null);
  const openMarket = useCallback((market: Market) => { rememberTradingMarket(market); setOpenedMarket(market); setPage('trading'); }, []);
  const openRisk = useCallback(() => setSettings('risk'), []);
  const chains = state?.chains ?? [];
  return <div className="app-shell"><header className="app-header"><button className="brand" onClick={() => setPage('trading')} aria-label="返回模拟交易"><span className="brand-mark"><i/><i/><i/></span><span>PAPER<span className="brand-light"> / TERMINAL</span><small>模拟交易与量化研究终端</small></span></button><nav className="main-nav" aria-label="主要页面">{pages.map(p => <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => { setOpenedMarket(null); setPage(p.id); }}><Icon name={p.icon} size={17}/>{p.name}</button>)}</nav><div className="header-right"><Badge tone="blue"><span className="status-dot blue"/>模拟模式</Badge><button className="icon-button" title="备份与恢复" aria-label="备份与恢复" onClick={() => setSettings('data')} disabled={!state}><Icon name="down"/></button><button className="icon-button" title="风险设置" aria-label="风险设置" onClick={() => setSettings('risk')} disabled={!state}><Icon name="settings"/></button></div></header>
    <ContextBar state={state} connection={connection} chain={chain} onChain={setChain} refresh={actions.refresh} openRisk={openRisk}/>
    {error && <div className="global-alert" role="alert"><Icon name="info" size={17}/><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => actions.setError('')}><Icon name="close" size={15}/></button></div>}
    <StateExpiryWarning at={state?.at ?? null}/>
    <EquityObservationProvider state={state}><main>{!state ? <div className="loading-layout"><div className="loading-content"><div className="loading-orbit"><Icon name="trade" size={32}/></div><div className="eyebrow">REAL MARKETS. PAPER CAPITAL.</div><h1>{connection === 'offline' ? '等待本机后台启动' : '正在连接研究终端'}</h1><p>读取真实行情、虚拟账户与持久化账本。<br/>行情为空时不会生成演示市场或盈利数据。</p><button className="button secondary" onClick={() => void actions.refresh()}><Icon name="refresh" size={15}/>重新连接</button></div><div className="loading-preview">{['真实链上行情', '按金额模拟成交', '8 个独立实验组', '封存后的实时检验'].map((text, i) => <div key={text}><span>0{i + 1}</span><strong>{text}</strong><Icon name="arrow" size={16}/></div>)}</div></div> : page === 'scanner' ? <Scanner state={state} chain={chain} onOpen={openMarket}/>: page === 'trading' ? <Trading state={state} chain={chain} actions={actions.controls} initialMarket={openedMarket}/> : page === 'robots' ? <Robots state={state} chain={chain} actions={actions.controls}/> : page === 'research' ? <Research state={state} chain={chain} actions={actions.controls}/> : <ObservedReview state={state} chain={chain} actions={actions.controls}/>}</main></EquityObservationProvider>
    <footer className="app-footer"><span><Icon name="shield" size={12}/>虚拟资金 · 无真实钱包接入</span><div>{chains.map(c => <span key={c.chain}><i className={`status-dot ${c.connected ? 'green' : 'amber'}`}/>{CHAIN_NAMES[c.chain]} {c.head ? '#' + c.head.toLocaleString('en-US') : '等待区块'}</span>)}</div><span>时间显示：北京时间 · v0.1</span></footer>
    {notice && <div className="toast" role="status"><span className="toast-check">✓</span>{notice}<button className="icon-button" aria-label="关闭通知" onClick={() => actions.setNotice('')}><Icon name="close" size={14}/></button></div>}
    {settings === 'risk' && state && <Modal title="虚拟账户风险设置" onClose={() => setSettings(null)}><RiskEditor risk={state.risk} pending={actions.pending} externalError={actions.error} onSave={async risk => { const success = await actions.mutate('/api/settings/risk', { risk }, '风险设置已更新。'); if (success) setSettings(null); return success; }}/></Modal>}
    {settings === 'data' && state && <DataSettings actions={actions} onClose={() => setSettings(null)}/>}
  </div>;
}
function DataSettings({ actions, onClose }: { actions: TerminalActions; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const restoring = useRef(false);
  useEffect(() => { if (actions.error) setError(actions.error); }, [actions.error]);
  const backup = async () => { if (!actions.state) return; setBusy(true); setError(''); try { await backupDatabase(actions.state.csrf); actions.setNotice('虚拟交易数据库备份已下载。'); } catch (e) { setError(e instanceof Error ? e.message : '备份失败。'); } finally { setBusy(false); } };
  const restore = async () => { if (!file || !confirmed || !actions.state || restoring.current) return; restoring.current = true; setBusy(true); setError(''); actions.setError(''); try { await restoreDatabase(file, actions.state.csrf); window.dispatchEvent(new Event('paper-restored')); await actions.refresh(); actions.setNotice('完整模拟账本已恢复；机器人保持暂停，等待当前行情核验。'); onClose(); } catch (e) { const message = e instanceof Error ? e.message : '恢复失败。'; setError(message); actions.setError(message); } finally { restoring.current = false; setBusy(false); } };
  return <Modal title="模拟账本备份与恢复" onClose={onClose}><div className="data-setting-section"><span className="setting-icon"><Icon name="down" size={23}/></span><div><h3>下载数据库备份</h3><p>保留完整历史、虚拟资金、持仓、订单、策略版本和研究记录。</p></div><button className="button secondary" disabled={busy || actions.pending} onClick={() => void backup()}>下载备份</button></div><div className="data-setting-section restore-section"><span className="setting-icon"><Icon name="up" size={23}/></span><div><h3>恢复已有备份</h3><p>完整历史备份最大支持 8GB。将替换当前模拟账本，建议先下载当前备份。</p></div></div><label className="file-input"><Icon name="up" size={18}/><span>{file?.name || '选择本工具导出的 SQLite 备份'}</span><input aria-label="选择模拟数据库备份" type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3,application/octet-stream" disabled={busy || actions.pending} onChange={e => { setFile(e.target.files?.[0] ?? null); setConfirmed(false); }}/></label><label className="checkbox restore-confirm"><input type="checkbox" checked={confirmed} disabled={busy || actions.pending} onChange={e => setConfirmed(e.target.checked)}/>我已保存需要的记录，确认替换当前虚拟账本</label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button danger full" disabled={!file || !confirmed || busy || actions.pending} onClick={() => void restore()}>{busy ? '正在处理完整备份…' : '恢复模拟数据库'}</button><p className="panel-note">备份和恢复仅操作本机虚拟账本，不接入真实钱包。</p></Modal>;
}
