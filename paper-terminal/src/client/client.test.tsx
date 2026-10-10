import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RISK, DEFAULT_RULES } from '../shared/domain';
import type { Account, AppState, Market, MarketEvent, Strategy } from '../shared/domain';
import { extractError, normalizeCandles, originalSellQuantity, rawQuantity, savedEquityPoints, validateRules } from './lib';
import { MAX_RESTORE_BYTES, backupDatabase, request, restoreDatabase } from './api';
import { Trading, retainMarketSelection } from './Trading';
import { Robots } from './Robots';
import { Research } from './Research';
import { ControlWalletPanel, Review } from './Review';
import { ContextBar } from './ContextBar';
import { RiskEditor, RulesEditor } from './ui';
import { aggregateCandles, candleTimeForFill, candleUpdatePlan, formatChartTime, readCandleMetadata } from './Chart';
import { Scanner, filterScannerMarkets, marketAgeMs, scannerStage } from './Scanner';
import { TickMarkType, type UTCTimestamp } from 'lightweight-charts';
import type { TerminalActions } from './useTerminal';

const base: AppState = { mode: 'paper', at: 1791250000000, csrf: 'test-csrf', chains: [], markets: [], accounts: [], positions: [], orders: [], fills: [], strategies: [], researchRuns: [], audit: [], risk: DEFAULT_RISK, health: {} };
const actions = { pending: false, mutate: async () => true, setError: () => {}, setNotice: () => {} } as unknown as TerminalActions;
const makeAccount = (id: string, chain: Account['chain'], kind: Account['kind'] = 'bot'): Account => ({ id, name: `账户 ${id}`, chain, kind, initialCapitalUsd: 100, nativeBalanceRaw: null, nativeUsd: null, cashUsd: 100, equityUsd: 100, conservativeEquityUsd: 100, realizedUsd: 0, feesUsd: 0, reservedNativeRaw: '0', createdAt: base.at, paused: false, day: '2026-10-06', dayStartEquityUsd: 100, dayEntries: 0, dayNetUsd: 0, consecutiveLosses: 0, haltReason: '' });

test('robots distinguish unvalidated experiments and show actual blockers and complete-order counts',()=>{
 const formal:Strategy={id:'bsc-wallet-short',name:'正式组',accountId:'formal',chain:'bsc',family:'wallet',horizon:'short',state:'waiting',reason:'等待验证',rules:DEFAULT_RULES,version:'1',researchRunId:null,wallets:[],lastDecisionAt:0};
 const trial:Strategy={...formal,id:'paper-experiment-bsc-wallet-short',name:'独立试运行',accountId:'trial',state:'running',mode:'experiment'};
 const state:AppState={...base,accounts:[makeAccount('formal','bsc'),makeAccount('trial','bsc','research')],strategies:[formal,trial],robotDiagnostics:[{strategyId:trial.id,signals:11,tokens:3,readySamples:1,readyPairs:2,failedPreparations:8,expiredPreparations:2,filledOrders:425,lastSignalAt:base.at,latestPreparationAt:base.at,latestPreparationReason:'费用未知',collectingSince:base.at,earliestTrainingAt:base.at+21*86400000,dataFresh:true}]};
 const html=renderToStaticMarkup(<Robots state={state} chain="bsc" actions={actions}/>);assert.match(html,/未验证试运行/);assert.match(html,/最近报价被拦：费用未知/);assert.match(html,/425/);assert.match(html,/已有独立试运行/);assert.match(html,/\$200/);assert.doesNotMatch(html,/已验证策略运行中/);assert.ok(html.indexOf('<h2>独立试运行')<html.indexOf('<h2>正式组'));
});

test('formal research excludes experimental strategies from its selection and promotion view',()=>{
 const trial:Strategy={id:'trial',name:'未验证试运行专用名称',accountId:'trial',chain:'bsc',family:'wallet',horizon:'short',state:'running',mode:'experiment',reason:'试运行',rules:DEFAULT_RULES,version:'1',researchRunId:null,wallets:[],lastDecisionAt:0};
 const html=renderToStaticMarkup(<Research state={{...base,strategies:[trial]}} chain="bsc" actions={actions}/>);assert.doesNotMatch(html,/未验证试运行专用名称/);
});

test('account summary includes independent paper experiments without counting unrelated research bankrolls',()=>{
 const trial:Strategy={id:'trial',name:'试运行',accountId:'trial',chain:'bsc',family:'wallet',horizon:'short',state:'running',mode:'experiment',reason:'试运行',rules:DEFAULT_RULES,version:'1',researchRunId:null,wallets:[],lastDecisionAt:0};
 const unrelated=makeAccount('unrelated','bsc','research');unrelated.conservativeEquityUsd=999;const html=renderToStaticMarkup(<ContextBar state={{...base,accounts:[makeAccount('manual','bsc','manual'),makeAccount('bot','bsc'),makeAccount('trial','bsc','research'),unrelated],strategies:[trial]}} connection="live" chain="bsc" onChain={()=>{}} refresh={async()=>{}} openRisk={()=>{}}/>);assert.match(html,/\$300/);assert.match(html,/1 个试运行/);assert.doesNotMatch(html,/\$999|\$1,299/);
});

test('empty real state renders trading without invented markets or enabled buy', () => {
  const html = renderToStaticMarkup(<Trading state={base} chain="bsc" actions={actions}/>);
  assert.match(html, /等待真实市场数据/); assert.match(html, /暂无手动账户/);
  assert.match(html, /按原始总仓位/); assert.match(html, /行情未就绪/);
  assert.match(html, /disabled=""[^>]*>模拟买入/);
});
test('eight independent bot accounts retain actual metrics and reasons', () => {
  const accounts = Array.from({ length: 8 }, (_, i) => makeAccount(`bot-${i}`, i < 4 ? 'bsc' : 'robinhood'));
  accounts[2].conservativeEquityUsd = 91.25;
  const strategies: Strategy[] = accounts.map((a, i) => ({ id: `strategy-${i}`, name: `实验 ${i}`, accountId: a.id, chain: a.chain, family: i % 2 ? 'momentum' : 'wallet', horizon: i % 4 < 2 ? 'short' : 'swing', state: 'waiting', reason: `样本不足 ${i}`, rules: DEFAULT_RULES, version: '1', researchRunId: null, wallets: [], lastDecisionAt: 0 }));
  const html = renderToStaticMarkup(<Robots state={{ ...base, accounts, strategies }} chain="bsc" actions={actions}/>);
  assert.equal((html.match(/class="robot-card panel"/g) ?? []).length, 8);
  assert.match(html, /\$91\.25/); assert.match(html, /样本不足 7/); assert.match(html, /单笔计划损失 ≤ 0\.5%/); assert.match(html, /Robinhood/);
});
test('research empty metrics are missing values, with 32 candidates and forward gate', () => {
  const html = renderToStaticMarkup(<Research state={base} chain="bsc" actions={actions}/>);
  assert.match(html, /32 组合/); assert.match(html, /7 天新行情/); assert.match(html, /暂无结果/); assert.match(html, /90% 下界/); assert.doesNotMatch(html, /\+\$/);
});
test('review handles multiple chain-specific manual accounts without inventing curves', () => {
  const accounts = [makeAccount('manual-bsc', 'bsc', 'manual'), makeAccount('manual-rh', 'robinhood', 'manual')];
  const html = renderToStaticMarkup(<Review state={{ ...base, accounts }} chain="robinhood" actions={actions} history={{}}/>);
  assert.match(html, /账户 manual-rh/); assert.doesNotMatch(html, /账户 manual-bsc/); assert.match(html, /等待第二个真实净值快照/); assert.match(html, /暂无持仓/);
});
test('original percentage uses frozen lot and clamps to remaining instead of compounding', () => {
  const p = { originalRaw: '100000000000000000000', remainingRaw: '40000000000000000000' };
  assert.equal(originalSellQuantity(p, 25), '25000000000000000000');
  assert.equal(originalSellQuantity(p, 50), p.remainingRaw);
  assert.equal(originalSellQuantity(p, 100), p.remainingRaw);
  assert.equal(originalSellQuantity(p, -10), '0');
  assert.equal(rawQuantity('1234500000000000000'), '1.2345');
});
test('exit rules reject excessive original fractions, duplicates and invalid values', () => {
  assert.equal(validateRules(DEFAULT_RULES), null);
  assert.match(validateRules({ ...DEFAULT_RULES, targets: [{ gainPct: 30, sellOriginalPct: 60 }, { gainPct: 60, sellOriginalPct: 60 }] }) ?? '', /100%/);
  assert.match(validateRules({ ...DEFAULT_RULES, targets: [{ gainPct: 30, sellOriginalPct: 50 }, { gainPct: 30, sellOriginalPct: 50 }] }) ?? '', /重复/);
  assert.match(validateRules({ ...DEFAULT_RULES, stopPct: NaN }) ?? '', /止损/);
  const html = renderToStaticMarkup(<RulesEditor rules={DEFAULT_RULES} onChange={() => {}}/>);
  assert.match(html, /按原始总仓位/); assert.match(html, /合计卖出原仓 50%/);
  assert.match(html, /首卖后保护剩余成本（含费用）/);
});
test('candles normalize seconds and milliseconds, sort and dedupe without synthetic bars', () => {
  const raw = [{ time: 1700000030000, open: 2, high: 3, low: 1, close: 2.5, volume: 12 }, { time: 1700000000, open: 1, high: 2, low: .5, close: 1.5, volume: 9 }, { time: 1700000000000, open: 1, high: 2, low: .5, close: 1.7, volume: 11 }, { time: 1700000060, open: 2, high: 1, low: 3, close: 2, volume: 2 }];
  const candles = normalizeCandles(raw); assert.equal(candles.length, 2); assert.equal(candles[0].time, 1700000000); assert.equal(candles[0].close, 1.7); assert.equal(candles[1].time, 1700000030);
});
test('POST sends exact CSRF and preserves actionable API errors', async t => {
  let received: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { received = init; return new Response(JSON.stringify({ error: '费用超过风险预算，请减少金额。' }), { status: 400 }); });
  await assert.rejects(request('/api/paper/orders', 'the-token', { clientId: 'id', amountUsd: 2 }), /费用超过风险预算/);
  assert.equal(received?.method, 'POST'); assert.equal((received?.headers as Record<string, string>)['X-CSRF-Token'], 'the-token'); assert.equal(received?.body, '{"clientId":"id","amountUsd":2}');
  assert.equal(extractError(null, 'fallback'), 'fallback');
});
test('successful empty response is valid and GET does not attach mutation headers', async t => {
  let received: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { received = init; return new Response(null, { status: 204 }); });
  assert.equal(await request('/api/state'), undefined); assert.equal(received?.method, 'GET'); assert.equal(received?.headers, undefined);
});
test('persisted curve accepts only recorded conservative values and never reconstructs profit', () => {
  const result = savedEquityPoints({ equity: { manual: [{ at: 1700000000000, value: 150, conservative: 90 }, { at: 1700000030000, value: 160 }, { at: 1700000060000, conservative: NaN }] } }, 'manual');
  assert.deepEqual(result, [{ time: 1700000000, value: 90 }]); assert.deepEqual(savedEquityPoints({}, 'manual'), []);
});
test('binary database backup still sends JSON content-type and CSRF required by server', async t => {
  let received: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { received = init; return new Response(JSON.stringify({ error: '备份正在占用，请稍后再试。' }), { status: 400 }); });
  await assert.rejects(backupDatabase('backup-token'), /备份正在占用/);
  assert.equal((received?.headers as Record<string, string>)['Content-Type'], 'application/json'); assert.equal((received?.headers as Record<string, string>)['X-CSRF-Token'], 'backup-token'); assert.equal(received?.body, '{}');
});
test('risk API rejection is visible inside the settings dialog instead of behind the overlay', () => {
  const html = renderToStaticMarkup(<RiskEditor risk={DEFAULT_RISK} onSave={async () => false} pending={false} externalError="首版风险限制只能收紧"/>);
  assert.match(html, /role="alert"[^>]*>首版风险限制只能收紧/);
});
test('large restore sends the exact File as binary with CSRF, without pre-reading or text expansion', async t => {
  const file = new File(['SQLite format 3\0'], 'full-history.sqlite');
  Object.defineProperty(file, 'size', { value: 70 * 1024 * 1024 });
  t.mock.method(file, 'arrayBuffer', () => { throw Error('must not pre-read the complete backup'); });
  t.mock.method(file, 'text', () => { throw Error('must not turn the backup into text'); });
  let received: RequestInit | undefined; let path: unknown;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => { path = url; received = init; return new Response(JSON.stringify({ restored: true }), { status: 200 }); });
  await restoreDatabase(file, 'current-csrf');
  assert.equal(path, '/api/restore'); assert.equal(received?.method, 'POST'); assert.equal(received?.body, file); assert.equal(received?.credentials, 'same-origin');
  assert.equal((received?.headers as Record<string, string>)['Content-Type'], 'application/vnd.sqlite3'); assert.equal((received?.headers as Record<string, string>)['X-CSRF-Token'], 'current-csrf');
});
test('restore permits the 8GB boundary and rejects larger or empty backups before upload', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ restored: true }), { status: 200 }); });
  const boundary = new File(['SQLite format 3\0'], 'boundary.sqlite'); Object.defineProperty(boundary, 'size', { value: MAX_RESTORE_BYTES });
  await restoreDatabase(boundary, 'csrf'); assert.equal(calls, 1);
  const excessive = new File(['SQLite format 3\0'], 'excessive.sqlite'); Object.defineProperty(excessive, 'size', { value: MAX_RESTORE_BYTES + 1 });
  await assert.rejects(restoreDatabase(excessive, 'csrf'), /8GB/);
  await assert.rejects(restoreDatabase(new File([], 'empty.sqlite'), 'csrf'), /为空/); assert.equal(calls, 1);
});
test('binary restore preserves API error details and requires explicit successful confirmation', async t => {
  const file = new File(['SQLite format 3\0'], 'backup.sqlite');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: '备份文件校验失败，当前账本未替换。' }), { status: 400 }));
  await assert.rejects(restoreDatabase(file, 'csrf'), /备份文件校验失败，当前账本未替换/);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ restored: false }), { status: 200 }));
  await assert.rejects(restoreDatabase(file, 'csrf'), /后台尚未确认恢复成功/);
});
test('default market remains selected through reordered rankings, fresh data and catalog eviction', () => {
  const makeMarket = (address: string, volumeUsd: number): Market => ({ id: 'bsc:' + address, chain: 'bsc', address, name: address, symbol: address, platform: 'flap', stage: 'inner', createdAt: base.at, priceUsd: 1, nativeUsd: 600, quoteAddress: '', decimals: 18, liquidityUsd: 500, volumeUsd, buyTaxPct: 0, sellTaxPct: 0, updatedAt: base.at, block: 1, quality: 'verified', reason: '' });
  const first = makeMarket('first', 100), second = makeMarket('second', 50);
  const initial = retainMarketSelection(null, 'bsc', [first, second]); assert.equal(initial?.token, 'first');
  const updatedSecond = { ...second, volumeUsd: 500 };
  assert.equal(retainMarketSelection(initial, 'bsc', [updatedSecond, first])?.token, 'first');
  const freshFirst = { ...first, priceUsd: 2, updatedAt: base.at + 1000 };
  const refreshed = retainMarketSelection(initial, 'bsc', [updatedSecond, freshFirst]); assert.equal(refreshed?.market, freshFirst);
  assert.equal(retainMarketSelection(refreshed, 'bsc', [updatedSecond])?.market, freshFirst);
  const rh = { ...second, chain: 'robinhood' as const };
  assert.equal(retainMarketSelection(refreshed, 'robinhood', [rh])?.market, rh);
  assert.equal(retainMarketSelection(null, 'bsc', []), null);
});
test('initial display prefers verified positive prices, falls back truthfully, and never overrides an existing user selection', () => {
  const make = (address: string, priceUsd: number | null, quality: Market['quality']): Market => ({ id: address, chain: 'bsc', address, priceUsd, quality, name: address, symbol: address, platform: '', stage: '', createdAt: 0, nativeUsd: null, quoteAddress: '', decimals: null, liquidityUsd: null, volumeUsd: null, buyTaxPct: null, sellTaxPct: null, updatedAt: 0, block: 0, reason: '' });
  const missing = make('missing', null, 'unavailable'), priced = make('priced', 1, 'estimated'), verified = make('verified', .01, 'verified');
  assert.equal(retainMarketSelection(null, 'bsc', [missing, priced, verified])?.token, 'verified');
  assert.equal(retainMarketSelection(null, 'bsc', [missing, priced])?.token, 'priced');
  assert.equal(retainMarketSelection(null, 'bsc', [missing])?.token, 'missing');
  assert.equal(retainMarketSelection({ chain: 'bsc', token: missing.address, market: missing }, 'bsc', [verified, missing])?.token, 'missing');
});
test('gateway candle status supports real local bars while history is pending and never invents readiness', () => {
  const status = { source: 'verified-local', state: 'ready', pending: true, reason: '显示已取得的真实K线，历史数据正在优先补充', rows: 4, historyAt: null };
  assert.equal(readCandleMetadata({ candles: [], meta: status })?.pending, true);
  assert.equal(readCandleMetadata({ candles: [], ...status })?.source, 'verified-local');
  assert.equal(readCandleMetadata({ candles: [] }), null);
  assert.equal(readCandleMetadata({ candles: [], meta: { ...status, source: 'fictional' } })?.source, undefined);
  assert.equal(readCandleMetadata({ candles: [], source: 'verified-local', pending: true, reason: '正在补历史' })?.pending, true);
});
test('read-only control handles absent optional fields without creating account or profit data', () => {
  const html = renderToStaticMarkup(<ControlWalletPanel state={base} chain="bsc"/>);
  assert.match(html, /你的钱包 · 只读对照/); assert.match(html, /尚未接入只读对照钱包/); assert.match(html, /每笔完整成本尚未核实/); assert.doesNotMatch(html, /\$100|模拟账户|盈利金额/);
});
test('control table displays only own verified buys and sells on selected chain, with missing cost values unknown', () => {
  const address = '0x115d9f406cb33e67c19a7ccc4b1676197d9e295c';
  const event: MarketEvent = { id: 'buy', chain: 'bsc', kind: 'wallet', block: 10, at: base.at, receivedAt: base.at + 500, wallet: address, token: '0x1111111111111111111111111111111111111111', side: 'buy', priceUsd: .002, amountUsd: 10, payload: { verified: true } };
  const controlState: AppState = { ...base, controlWallets: [{ chain: 'bsc', address, name: '你的钱包' }, { chain: 'robinhood', address, name: '你的钱包' }], controlActivity: [event, { ...event, id: 'sell', side: 'sell', amountUsd: undefined, priceUsd: undefined, at: base.at + 1000 }, { ...event, id: 'wrong-chain', chain: 'robinhood', amountUsd: 999 }, { ...event, id: 'unverified', amountUsd: 777, payload: { verified: false } }, { ...event, id: 'removed', amountUsd: 888, payload: { verified: true, removed: true } }, { ...event, id: 'other-wallet', wallet: '0x2222222222222222222222222222222222222222', amountUsd: 666 }] };
  const html = renderToStaticMarkup(<ControlWalletPanel state={controlState} chain="bsc"/>);
  assert.match(html, new RegExp(address)); assert.match(html, /买入成交额/); assert.match(html, /卖出成交额/); assert.match(html, /\$10\.00/); assert.match(html, /链上买卖已核实/); assert.match(html, /—/);
  assert.doesNotMatch(html, /\$999|\$777|\$888|\$666|盈利金额/);
});
test('robot collection progress displays backend counters and the 21 plus 7 day requirement without enabling strategies', () => {
  const html = renderToStaticMarkup(<Robots state={{ ...base, health: { sampleCount: 42, quoteCount: 1234, activeResearchTapes: 3, recordingSince: base.at - 2 * 86400000 } }} chain="bsc" actions={actions}/>);
  assert.match(html, /行情采集中 \/ 可启动独立试运行/); assert.match(html, /采集记录总数/); assert.match(html, /1,234/); assert.match(html, /开始至今 2\.00 天，包含缺口/); assert.match(html, /至少需要 21 天/); assert.match(html, /封存参数后再检验 7 天/); assert.match(html, /不能替代正式验证/);
});
test('chart ticks and crosshair display Beijing time consistently, including a UTC date rollover', () => {
  const instant = (Date.parse('2026-10-06T11:23:45Z') / 1000) as UTCTimestamp;
  assert.equal(formatChartTime(instant, TickMarkType.Time), '19:23');
  assert.equal(formatChartTime(instant, TickMarkType.TimeWithSeconds), '19:23:45');
  assert.match(formatChartTime(instant), /10\/06.*19:23:45/);
  const rollover = (Date.parse('2026-10-06T20:15:00Z') / 1000) as UTCTimestamp;
  assert.equal(formatChartTime(rollover, TickMarkType.DayOfMonth), '10/07');
  assert.match(formatChartTime(rollover), /10\/07.*04:15:00/);
});

const scannerMarket: Market = { id: 'scanner-bsc', chain: 'bsc', address: '0x1111111111111111111111111111111111111111', name: '真实样本字段', symbol: '样本', platform: 'flap', stage: 'curve', createdAt: base.at - 10000, priceUsd: .01, nativeUsd: 600, quoteAddress: 'native', decimals: 18, liquidityUsd: 20, volumeUsd: 30, buyTaxPct: null, sellTaxPct: null, updatedAt: base.at, block: 100, quality: 'verified', reason: '' };
test('scanner trusts merged server classification and falls back to phase only for legacy markets', () => {
  assert.equal(scannerStage(scannerMarket), 'new');
  assert.equal(scannerStage({ ...scannerMarket, progressPct: 99 }), 'new');
  assert.equal(scannerStage({ ...scannerMarket, scannerStage: 'near' }), 'near');
  assert.equal(scannerStage({ ...scannerMarket, stage: 'dex', scannerStage: 'near' }), 'near');
  assert.equal(scannerStage({ ...scannerMarket, scannerStage: 'graduated' }), 'graduated');
  assert.equal(scannerStage({ ...scannerMarket, stage: 'dex' }), 'graduated');
  assert.equal(scannerStage({ ...scannerMarket, stage: 'unknown', scannerStage: 'near' }), 'near');
  assert.equal(scannerStage({ ...scannerMarket, stage: 'unknown' }), 'unknown');
});
test('a merged graduation event stays in the graduated column while the older curve phase awaits refresh', () => {
  const market: Market = { ...scannerMarket, symbol: '毕业事件', stage: 'curve', scannerStage: 'graduated', scannerAt: base.at + 1000 };
  const html = renderToStaticMarkup(<Scanner state={{ ...base, markets: [market] }} chain="bsc" onOpen={() => {}}/>);
  const graduated = html.split('class="scanner-column panel graduated"')[1]?.split('</section>')[0] ?? '';
  const newMarkets = html.split('class="scanner-column panel new"')[1]?.split('</section>')[0] ?? '';
  assert.match(graduated, /毕业事件/);
  assert.doesNotMatch(newMarkets, /毕业事件/);
  assert.equal(scannerStage({ ...market, stage: 'dex' }), 'graduated');
});
test('scanner chain, age, search and actual platform filters exclude unknown ages truthfully', () => {
  const older = { ...scannerMarket, id: 'older', address: '0x2222222222222222222222222222222222222222', platform: 'four', createdAt: base.at - 7200000, volumeUsd: 50 };
  const unknown = { ...scannerMarket, id: 'unknown', address: '0x3333333333333333333333333333333333333333', createdAt: 0, liquidityUsd: null };
  const rows = [unknown, older, { ...scannerMarket, id: 'other-chain', chain: 'robinhood' as const }, scannerMarket];
  assert.equal(marketAgeMs(unknown, base.at), null);
  assert.equal(marketAgeMs({ ...scannerMarket, createdAt: base.at + 1 }, base.at), null);
  assert.deepEqual(filterScannerMarkets(rows, 'bsc', '', 600000, 'newest', base.at).map(m => m.id), ['scanner-bsc']);
  assert.deepEqual(filterScannerMarkets(rows, 'bsc', 'four', 0, 'volume', base.at, 'four').map(m => m.id), ['older']);
  assert.deepEqual(filterScannerMarkets(rows, 'bsc', '', 0, 'newest', base.at).map(m => m.id), ['scanner-bsc', 'older', 'unknown']);
  assert.equal(filterScannerMarkets(rows, 'bsc', 'NO-MATCH', 0, 'volume', base.at).length, 0);
});
test('scanner empty state retains three honest columns without demo markets or progress', () => {
  const html = renderToStaticMarkup(<Scanner state={base} chain="bsc" onOpen={() => {}}/>);
  assert.equal((html.match(/class="scanner-column panel/g) ?? []).length, 3);
  assert.match(html, /暂无即将毕业市场/); assert.match(html, /阶段待核实/); assert.match(html, /等待网络行情/);
  assert.doesNotMatch(html, /role="progressbar"|scanner-card-heading/);
});
test('scanner renders only provided progress in range and calls verified reference data market data', () => {
  const markets = [scannerMarket, { ...scannerMarket, id: 'near', scannerStage: 'near' as const, progressPct: 87.5 }, { ...scannerMarket, id: 'bad-progress', progressPct: 101 }, { ...scannerMarket, id: 'unknown-stage', stage: 'unknown', progressPct: 10 }, { ...scannerMarket, id: 'other-chain', chain: 'robinhood' as const, symbol: '不属于本链' }];
  const html = renderToStaticMarkup(<Scanner state={{ ...base, markets }} chain="bsc" onOpen={() => {}}/>);
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 2);
  assert.match(html, /87\.5%/); assert.match(html, /10\.0%/); assert.match(html, /行情已核实/); assert.match(html, /扫链平台/);
  assert.doesNotMatch(html, /报价已核实|101%|不属于本链/);
});
test('chart periods combine only real OHLCV, keep missing windows absent and do not mutate source', () => {
  const time = 1800000000;
  const a = { time, open: 10, high: 12, low: 9, close: 11, volume: 4 };
  const b = { time: time + 30, open: 11, high: 15, low: 8, close: 13, volume: 7 };
  const c = { time: time + 180, open: 20, high: 25, low: 18, close: 22, volume: 9 };
  const source = [c, b, a]; const saved = structuredClone(source);
  assert.deepEqual(aggregateCandles(source, 30), [a, b, c]);
  assert.deepEqual(aggregateCandles(source, 60), [{ time, open: 10, high: 15, low: 8, close: 13, volume: 11 }, c]);
  for (const period of [300, 900, 3600]) assert.deepEqual(aggregateCandles(source, period), [{ time, open: 10, high: 25, low: 8, close: 22, volume: 20 }]);
  assert.deepEqual(source, saved); assert.throws(() => aggregateCandles(source, 1), /不支持/);
  const initial = aggregateCandles([a], 60), next = aggregateCandles([a, b], 60);
  assert.deepEqual(candleUpdatePlan(initial, next), { replace: false, updates: next });
});
test('fill markers belong only to the candle period containing their actual timestamp', () => {
  const time = 1800000000;
  const a = { time, open: 1, high: 1, low: 1, close: 1, volume: 1 };
  const c = { ...a, time: time + 180 };
  assert.equal(candleTimeForFill([a, c], time + 29, 30), time);
  assert.equal(candleTimeForFill([a, c], time + 30, 30), null);
  assert.equal(candleTimeForFill([a, c], time + 59, 60), time);
  assert.equal(candleTimeForFill([a, c], time + 60, 60), null);
  assert.equal(candleTimeForFill([a, c], time + 100, 60), null);
  assert.equal(candleTimeForFill([a, c], time + 180, 60), time + 180);
  assert.equal(candleTimeForFill([a, c], time - 1, 60), null);
});
