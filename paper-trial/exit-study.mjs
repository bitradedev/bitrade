import {percentRaw,nativeUsd} from '../paper-terminal/dist/server/money.js';

export const EXIT_VARIANTS=[
 {id:'tight',name:'紧止损',stopPct:8,targetPct:15,sellPct:50,trailPct:8,maxHoldMs:600000},
 {id:'balanced',name:'中等止损',stopPct:12,targetPct:25,sellPct:50,trailPct:12,maxHoldMs:1800000},
 {id:'wide',name:'宽止损',stopPct:18,targetPct:40,sellPct:50,trailPct:20,maxHoldMs:3600000},
];
const extra=q=>q.fees.gasUsd+q.fees.approvalUsd;
export function studyAction(c,rule,price,now){
 const gain=(price/c.entryPriceUsd-1)*100,reduced=BigInt(c.remainingRaw)<BigInt(c.originalRaw);
 if(gain<=-rule.stopPct)return {all:true,reason:`止损${rule.stopPct}%`};
 if(reduced&&price<=c.peakPriceUsd*(1-rule.trailPct/100))return {all:true,reason:`减仓后回撤${rule.trailPct}%`};
 if(now-c.openedAt>=rule.maxHoldMs)return {all:true,reason:`最长持有${rule.maxHoldMs/60000}分钟`};
 if(!c.targetDone&&gain>=rule.targetPct)return {all:false,reason:`上涨${rule.targetPct}%卖原仓${rule.sellPct}%`};
 return null;
}
export function studyMetrics(groups){
 // Compare only matched entry groups completed by EVERY variant, avoiding
 // rewarding the fastest exit just because other variants are still holding.
 const paired=groups.filter(g=>g.cases.every(c=>c.closedAt!==null));
 const rows=EXIT_VARIANTS.map(v=>{
  const cases=paired.map(g=>g.cases.find(c=>c.variantId===v.id)),profit=cases.reduce((n,c)=>n+c.profitUsd,0),basis=cases.reduce((n,c)=>n+c.costUsd,0),wins=cases.filter(c=>c.profitUsd>0),losses=cases.filter(c=>c.profitUsd<0);
  let balance=200,peak=200,realizedDrawdown=0;for(const c of [...cases].sort((a,b)=>a.closedAt-b.closedAt)){balance+=c.profitUsd;peak=Math.max(peak,balance);realizedDrawdown=Math.max(realizedDrawdown,(peak-balance)/peak*100);}
  const grossWins=wins.reduce((n,c)=>n+c.profitUsd,0),grossLosses=-losses.reduce((n,c)=>n+c.profitUsd,0);
  return {...v,count:cases.length,tokens:new Set(paired.map(g=>g.token)).size,profitUsd:profit,returnPct:basis?profit/basis*100:null,winRate:cases.length?wins.length/cases.length*100:null,
   profitFactor:grossLosses?grossWins/grossLosses:null,realizedDrawdownPct:cases.length?realizedDrawdown:null,feesUsd:cases.reduce((n,c)=>n+c.feesUsd,0),pending:groups.length-paired.length};
 });
 const comparable=paired.length>=20&&rows.every(r=>r.tokens>=5),best=comparable?[...rows].sort((a,b)=>b.profitUsd-a.profitUsd)[0]:null;
 return {pairedCount:paired.length,entryCount:groups.length,rows,conclusion:!comparable?'样本不足：至少20组完整配对、5个不同代币后再比较。':best.profitUsd<=0?'当前配对样本全部未获得净盈利，暂无盈利方案。':`${best.name}在当前配对样本中净收益最高；仅为候选，须用后续新样本验证。`,candidate:best?.profitUsd>0?best.id:null};
}
export class ExitStudy {
 busy=false;cursor=0;
 constructor(store,broker,clock=()=>Date.now(),monotonic=()=>performance.now()){
  this.store=store;this.broker=broker;this.now=clock;this.monotonic=monotonic;this.data=store.meta('exitStudy')??{startedAt:clock(),groups:[],seen:[]};
  for(const g of this.data.groups)for(const c of g.cases)if(c.pending){c.pending=null;c.reason='进程重启：旧退出准备失效，保留余仓重新报价';}
  this.save();
 }
 save(){this.store.setMeta('exitStudy',this.data);}
 onGap(chain){for(const g of this.data.groups.filter(g=>g.chain===chain))for(const c of g.cases)if(c.pending){c.pending=null;c.reason='行情缺口：退出准备失效，保留余仓';}this.save();}
 captureEntries(){
  for(const fill of this.broker.fills().filter(f=>f.side==='buy'&&f.accountId.startsWith('trial-')&&!f.accountId.endsWith('-check')&&f.at>=this.data.startedAt&&!this.data.seen.includes(f.id))){
   this.data.seen.push(fill.id);const order=this.broker.orders().find(o=>o.id===fill.orderId);
   const canCompare=EXIT_VARIANTS.every(v=>{const cases=this.data.groups.filter(g=>g.chain===fill.chain).map(g=>g.cases.find(c=>c.variantId===v.id));return cases.filter(c=>!c.closedAt).length<3&&200+cases.reduce((n,c)=>n+c.proceedsUsd-c.costUsd,0)>=fill.usd;});
   if(!canCompare){this.store.audit('exit-study','对照组资金或持仓上限不足，本次三组共同跳过，不补造仓位',{chain:fill.chain,token:fill.token,entryAt:fill.at});continue;}
   const fees=fill.fees.gasUsd+fill.fees.approvalUsd+fill.fees.protocolUsd+fill.fees.taxUsd+fill.fees.conversionUsd;
   const group={id:fill.id,chain:fill.chain,token:fill.token,entryAt:fill.at,entryBlock:fill.block,sourceAccountId:fill.accountId,entryQuoteId:order?.fillQuote?.id,cases:EXIT_VARIANTS.map(v=>({variantId:v.id,originalRaw:fill.tokenRaw,remainingRaw:fill.tokenRaw,decimals:order.fillQuote.tokenDecimals,entryPriceUsd:fill.priceUsd,peakPriceUsd:fill.priceUsd,costUsd:fill.usd,proceedsUsd:0,feesUsd:fees,profitUsd:0,openedAt:fill.at,closedAt:null,targetDone:false,targetSoldRaw:'0',pending:null,reason:'镜像同一笔已模拟成交的入场，等待各自退出条件',approvalPaid:false,exits:[]}))};
   this.data.groups.push(group);this.store.audit('exit-study','同一模拟入场启动三组止盈止损对照',{chain:group.chain,token:group.token,entryAt:fill.at,entryBlock:fill.block,entryQuoteId:group.entryQuoteId,units:fill.tokenRaw,costUsd:fill.usd});
  }
 }
 async tick(){
  if(this.busy||this.broker.stopped||this.broker.activeSubmissions||this.broker.inFlight.size)return;this.busy=true;
  try{
   this.captureEntries();const open=this.data.groups.flatMap(g=>g.cases.filter(c=>!c.closedAt).map(c=>({g,c}))),selected=open.length?Array.from({length:Math.min(3,open.length)},(_,i)=>open[(this.cursor+i)%open.length]):[];this.cursor+=selected.length;
   const cache=new Map();
   const get=async(g,c,raw,head)=>{
    const key=[g.chain,g.token,raw,head.head,this.broker.recipient(g.sourceAccountId)].join(':');
    if(!cache.has(key))cache.set(key,this.broker.getQuote('exit-study-'+g.id,{chain:g.chain,token:g.token,side:'sell',recipient:this.broker.recipient(g.sourceAccountId),tokenAmountRaw:raw,block:head.head}));
    const q=structuredClone(await cache.get(key));if(c.approvalPaid)q.fees.approvalUsd=0;
    const current=this.broker.fresh(g.chain),age=this.now()-q.at;
    if(!Number.isFinite(age)||age<0||age>5000||q.block>current.head)throw Error('研究报价已过期，保留余仓重新核实');
    if(q.spentInputRaw!==q.inputRaw||q.quality!=='verified'||q.fees.quality==='unavailable')throw Error('研究退出需要整仓可卖、已核实的具体数量报价及费用；未知或部分报价不视为成交');return q;
   };
   for(const {g,c} of selected){
    try{
     const now=this.now(),rule=EXIT_VARIANTS.find(v=>v.id===c.variantId),head=this.broker.fresh(g.chain);
     if(c.pending){
      if(now<c.pending.dueAt||this.monotonic()<c.pending.monoDue||head.head<=c.pending.block||head.headAt<c.pending.dueAt)continue;
      const p=c.pending,q=await get(g,c,p.raw,head);
      const cash=200+this.data.groups.filter(g2=>g2.chain===g.chain).map(g2=>g2.cases.find(c2=>c2.variantId===c.variantId)).reduce((n,c2)=>n+c2.proceedsUsd-c2.costUsd,0);
      if(cash<extra(q))throw Error('对照组现金不足以先支付退出费用，未模拟广播或扣费');
      if(BigInt(q.outputRaw)*100n<BigInt(p.quote.outputRaw)*97n){c.reason='研究退出报价超出3%滑点，保留余仓并扣除有报价依据的模拟失败Gas及授权费';c.proceedsUsd-=extra(q);c.feesUsd+=extra(q);c.approvalPaid||=q.fees.approvalUsd>0;c.exits.push({at:this.now(),block:q.block,quoteId:q.id,units:'0',netProceedsUsd:-extra(q),reason:c.reason,failed:true,fees:{gasUsd:q.fees.gasUsd,approvalUsd:q.fees.approvalUsd}});c.pending=null;continue;}
      const proceeds=nativeUsd(q.outputRaw,q.nativeUsd)-extra(q);if(proceeds<0)throw Error('可卖净额不足以承担退出费用');
      c.remainingRaw=String(BigInt(c.remainingRaw)-BigInt(q.spentInputRaw));c.proceedsUsd+=proceeds;c.feesUsd+=q.fees.gasUsd+q.fees.approvalUsd+q.fees.protocolUsd+q.fees.taxUsd+q.fees.conversionUsd;c.approvalPaid||=q.fees.approvalUsd>0;c.pending=null;
      if(!p.all){c.targetSoldRaw=String(BigInt(c.targetSoldRaw)+BigInt(q.spentInputRaw));c.targetDone=BigInt(c.targetSoldRaw)>=percentRaw(c.originalRaw,rule.sellPct);}
      c.reason=p.reason;c.exits.push({at:this.now(),block:q.block,quoteId:q.id,units:q.spentInputRaw,netProceedsUsd:proceeds,reason:p.reason,fees:q.fees});
      if(BigInt(c.remainingRaw)===0n){c.closedAt=this.now();c.profitUsd=c.proceedsUsd-c.costUsd;}
      this.store.audit('exit-study','止盈止损对照按后续区块真实报价记账',{chain:g.chain,token:g.token,variant:rule.name,reason:p.reason,quoteId:q.id,block:q.block,proceedsUsd:proceeds,closedAt:c.closedAt});
      continue;
     }
     const q=await get(g,c,c.remainingRaw,head);c.peakPriceUsd=Math.max(c.peakPriceUsd,q.priceUsd);
     const action=studyAction(c,rule,q.priceUsd,now);if(!action){c.reason='尚未触发此组退出条件';continue;}
     const raw=action.all?c.remainingRaw:String(percentRaw(c.originalRaw,rule.sellPct)-BigInt(c.targetSoldRaw));
     const reference=raw===c.remainingRaw?q:await get(g,c,raw,head);
     c.pending={raw,all:action.all,reason:action.reason,block:head.head,dueAt:this.now()+500,monoDue:this.monotonic()+500,quote:reference};c.reason=action.reason+'已触发，等待500毫秒和后续区块报价';
    }catch(e){c.reason=e.message;}
   }
   this.save();
  }finally{this.busy=false;}
 }
 state(chain){const groups=this.data.groups.filter(g=>g.chain===chain);return {startedAt:this.data.startedAt,mode:'paired-live-exit-scenarios',...studyMetrics(groups),recent:groups.slice(-8).reverse().map(g=>({token:g.token,entryAt:g.entryAt,entryBlock:g.entryBlock,costUsd:g.cases[0].costUsd,cases:g.cases.map(c=>({variantId:c.variantId,closedAt:c.closedAt,profitUsd:c.closedAt?c.profitUsd:null,reason:c.reason,remainingRaw:c.remainingRaw}))}))};}
}
