import {evaluateShortSignal, evaluateWalletSignal} from '../paper-terminal/dist/server/signals.js';
import {entryBlock} from '../paper-terminal/dist/server/risk.js';

export const CHAINS = ['bsc','robinhood'];
export const INITIAL_CAPITAL_USD=200;
export const MAX_ORDER_USD=40;
export const EXTERNAL_WINDOW_MS=90000;
export const EXTERNAL_SIGNAL_AGE_MS=60000;
export const INNER_SIGNAL_AGE_MS=30000;
export function retainedTrades(trades,now){return trades.filter(t=>now-t.at<Math.max(65000,EXTERNAL_WINDOW_MS*2+5000)).slice(-3000);}
export function signalDeadline(family,market,eventAt){return eventAt+(family==='wallet'||market.stage==='dex'?EXTERNAL_SIGNAL_AGE_MS:INNER_SIGNAL_AGE_MS);}
export function entryAttempt(orders,prefix){const prior=orders.filter(o=>o.clientId===prefix||o.clientId.startsWith(prefix+':'));return {allowed:prior.length<3&&!prior.some(o=>['waiting','queued','quoting','filled','partial'].includes(o.status)),index:prior.length};}
export const ACCOUNTS = CHAINS.flatMap(chain=>[
  {id:`trial-${chain}-momentum`, chain, name:'自主选币 · 内盘与外盘', family:'momentum'},
  {id:`trial-${chain}-wallet`, chain, name:'钱包首买试验', family:'wallet'},
]);
export const RULES = Object.freeze({stopPct:15, targets:[{gainPct:30,sellOriginalPct:50}], trailPct:20,maxHoldMs:600000,protectBreakeven:true});
export const RISK = Object.freeze({riskPct:5,maxPositionPct:20,maxPositions:3,dailyEntries:20,maxConsecutiveLosses:10,dailyLossPct:20});
export function eligibleMarket(market){
 if(!market)return false;if(market.chain!=='robinhood')return true;
 if(['pons','pons-v1'].includes(market.platform))return false;
 return market.platform==='pons-v2'||market.metadata?.route==='pons-v2'||market.stage==='dex'&&['v2','v3','v4'].includes(market.metadata?.route);
}
export function evaluateExternalSignal(c){
 const rows=c.trades.filter(t=>t.verified&&!t.removed&&t.at<=c.now&&t.receivedAt<=c.now&&t.priceUsd>0&&t.amountUsd>0);
 if(c.hasGap||c.now-c.coverageStart<EXTERNAL_WINDOW_MS*2)return {eligible:false,reason:'外盘需要缺口后连续观察至少3分钟'};
 const prior=rows.filter(t=>t.at>c.now-EXTERNAL_WINDOW_MS*2&&t.at<=c.now-EXTERNAL_WINDOW_MS),latest=rows.filter(t=>t.at>c.now-EXTERNAL_WINDOW_MS&&t.at<=c.now);
 if(!prior.length||!latest.length)return {eligible:false,reason:'外盘前后90秒都需要已核实成交'};
 const high=Math.max(...prior.map(t=>t.priceUsd)),pv=prior.reduce((n,t)=>n+t.amountUsd,0),lv=latest.reduce((n,t)=>n+t.amountUsd,0),buy=latest.filter(t=>t.side==='buy').reduce((n,t)=>n+t.amountUsd,0),sell=latest.filter(t=>t.side==='sell').reduce((n,t)=>n+t.amountUsd,0);
 if(c.priceUsd<=high)return {eligible:false,reason:'外盘没有突破前90秒高点'};
 if(lv<pv*1.5)return {eligible:false,reason:'外盘成交量没有达到此前1.5倍'};
 if(buy<=sell)return {eligible:false,reason:'外盘最新90秒买入金额没有超过卖出金额'};
 return {eligible:true,reason:'外盘突破前高、成交量放大至少1.5倍、净买入为正，准备实际金额报价',details:{high,previousVolume:pv,latestVolume:lv,buy,sell}};
}

export function decision({event,chain=event.chain,family,market,now,coverageStart,hasGap,trades,wallets}) {
  if(!eligibleMarket(market))return {eligible:false,reason:'内盘仅Pons V2；外盘要求已核实路线；跳过Pons V1及未核实平台'};
  if (!CHAINS.includes(chain)||event.chain!==chain||!market||market.chain!==chain||market.address.toLowerCase()!==event.token?.toLowerCase()||market.quality!=='verified'||event.replayed||event.payload?.verified!==true
      ||event.at>now||event.receivedAt>now||event.receivedAt<event.at||now-market.updatedAt>5000||market.updatedAt>now)
    return {eligible:false,reason:'需要刚收到的已核实成交和新鲜行情'};
  if (family==='wallet') return evaluateWalletSignal({chain,horizon:'swing',now,event,
    wallets,targetEntryPriceUsd:event.priceUsd,ourExecutablePriceUsd:market.priceUsd,
    firstVerifiedBuy:event.firstBuy===true,seenFirstBuys:new Set()});
  if(event.kind!=='trade'||now-event.at>(market.stage==='dex'?EXTERNAL_SIGNAL_AGE_MS:INNER_SIGNAL_AGE_MS))return {eligible:false,reason:market.stage==='dex'?'外盘成交信号已超过60秒':'内盘成交信号已超过30秒'};
  if(market.stage==='dex')return evaluateExternalSignal({now,priceUsd:market.priceUsd,coverageStart,hasGap,trades});
  return evaluateShortSignal({chain,token:event.token,now,createdAt:market.createdAt,
    priceUsd:market.priceUsd,priceAt:market.updatedAt,coverageStart,hasGap,trades});
}
export function admission(account,positions,orders,now,until) {
  if(now>=until)return '本轮24小时新仓观察窗口已结束，保留持仓退出管理';
  const blocked=entryBlock(account,positions,RISK);if(blocked)return blocked;
  const queued=orders.filter(o=>o.accountId===account.id&&o.side==='buy'&&['waiting','queued','quoting'].includes(o.status));
  if(queued.length+positions.filter(p=>p.accountId===account.id&&!p.closedAt).length>=RISK.maxPositions)return '含待成交订单已达到持仓上限';
  if(queued.length+account.dayEntries>=RISK.dailyEntries)return '含待成交订单已达到每天开仓上限';
  return null;
}
export function budgets(equity) {
  // Autonomous virtual spending, bounded by the user's $40 total order cap.
  const ceiling=Math.min(MAX_ORDER_USD,equity*RISK.maxPositionPct/100,equity*RISK.riskPct/(RULES.stopPct+3));
  return [ceiling,ceiling*.5,ceiling*.25].filter(x=>x>0);
}
export function assertOutlay(q){
 const outlay=Number(BigInt(q.spentInputRaw))/1e18*q.nativeUsd+q.fees.gasUsd+q.fees.approvalUsd;
 if(!Number.isFinite(outlay)||outlay>MAX_ORDER_USD+1e-6)throw Error('含Gas与授权费的单次投入不能超过40美元');
 return outlay;
}
