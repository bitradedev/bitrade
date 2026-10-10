import {fail} from './database.mjs';
import {avatarFor} from './agent-avatars.mjs';

export function strategyDto(agent){
 const s=agent.strategy??{};
 return {name:typeof s.name==='string'?s.name:'未填写策略',description:typeof s.description==='string'?s.description:'账户主人尚未提供公开策略说明。',kind:agent.source==='builtin'?'ai':'external',platformDefined:agent.source==='builtin',version:s.version??1};
}
export function publicAgent(store,paper,live,agent){
 const simulated=agent.mode==='paper',view=simulated?paper.view(agent.id):live.view(agent);
 const fills=simulated?paper.fills(agent.id):store.all('live-activity').filter(f=>f.agentId===agent.id);
 const knownSales=fills.filter(f=>f.side==='sell'&&f.netRaw!==null&&f.netRaw!==undefined&&!f.unknownCost);
 const realizedWei=simulated?view.realizedNativeRaw:view.realizedWei;
 const realizedUsd=simulated?knownSales.reduce((n,f)=>n+(Number.isFinite(f.netUsd)?f.netUsd:0),0):null;
 const wins=knownSales.filter(f=>simulated?f.netUsd>0:BigInt(f.netRaw)>0n).length;
 const openValues=simulated?view.positions.map(p=>p.estimatedValueUsd):[];
 const unrealizedUsd=simulated&&openValues.every(Number.isFinite)?openValues.reduce((n,x)=>n+x,0)-view.positions.reduce((n,p)=>n+p.usdCost,0):null;
 const runtime=agent.source==='builtin'?store.get('showcase-status',agent.id):null;
 const riskReviews=agent.source==='builtin'?[...new Set([...paper.lots(agent.id).map(p=>p.token),...fills.filter(f=>f.side==='buy').sort((a,b)=>b.at-a.at).slice(0,3).map(f=>f.token)])].map(token=>{const report=store.get('token-risk-reports',token);if(!report)return {token,state:'unknown',buyAllowed:false,reasons:['尚未取得持仓和捆绑风险资料'],metrics:null};return Date.now()-report.fetchedAt>120000?{...report,state:'unknown',buyAllowed:false,reasons:['持仓风险资料已过期，需要重新核查']}:report;}):[];
 return {id:agent.id,name:agent.name,avatar:avatarFor(agent),address:agent.address,mode:agent.mode,paused:agent.paused,source:agent.source==='builtin'?'builtin':'user',balanceWei:view.balanceWei,balanceUsd:simulated?view.balanceUsd:null,realizedWei,realizedUsd,returnPct:simulated?realizedUsd/view.initialUsd*100:null,unrealizedUsd,initialUsd:simulated?view.initialUsd:null,positions:view.positions.length,settledSales:knownSales.length,wins,winRate:knownSales.length?wins/knownSales.length*100:null,unknownCost:fills.filter(f=>f.unknownCost).length,createdAt:agent.createdAt,strategy:strategyDto(agent),riskReviews,runtime:runtime?{state:runtime.state,checkedAt:runtime.checkedAt??null,nextDecisionAt:runtime.nextDecisionAt??null,lastDecisionAt:runtime.lastDecisionAt??null,model:runtime.model??null,reason:runtime.reason??'',decision:runtime.decision?{action:runtime.decision.action,reason:runtime.decision.reason,token:runtime.decision.token,sizeUsd:runtime.decision.sizeUsd}:null}:null};
}
export function leaderboard(store,paper,live,url){
 const mode=url.searchParams.get('mode')??'paper',source=url.searchParams.get('source')??'all';
 if(!['paper','live'].includes(mode)||!['all','builtin','user'].includes(source))throw fail('排行榜筛选无效');
 const entries=store.all('agents').filter(a=>a.public&&!a.closedAt&&a.mode===mode&&(source==='all'||(a.source==='builtin'?'builtin':'user')===source)).map(a=>publicAgent(store,paper,live,a));
 entries.sort((a,b)=>{if(Boolean(a.settledSales)!==Boolean(b.settledSales))return a.settledSales?-1:1;if(mode==='paper')return b.returnPct-a.returnPct||b.settledSales-a.settledSales||a.createdAt-b.createdAt||a.id.localeCompare(b.id);const d=BigInt(b.realizedWei)-BigInt(a.realizedWei);return d>0n?1:d<0n?-1:a.id.localeCompare(b.id);});
 let rank=0,lastValue=null,lastRank=null;
 const rows=entries.map((e,i)=>{if(!e.settledSales)return {...e,rank:null};const value=mode==='paper'?e.returnPct:e.realizedWei;rank=i+1;if(value===lastValue)rank=lastRank;else{lastValue=value;lastRank=rank;}return {...e,rank};});
 return {mode,source,metric:mode==='paper'?'realized-usd-return':'realized-bnb-profit',definition:mode==='paper'?'已实现美元盈亏 ÷ 初始虚拟本金；包含成交费用，补足本金不算盈利。':'按已知 FIFO 成本的已实现 BNB 盈亏排序；充值、提现和成本未知资产不算盈利。',total:rows.length,ranked:rows.filter(x=>x.rank!==null).length,entries:rows.slice(0,100),updatedAt:Date.now()};
}
