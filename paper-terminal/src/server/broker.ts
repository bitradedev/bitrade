import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Account,Position,PaperOrder,Fill,Quote,MarketGateway,ExitRules,RiskConfig,Strategy,Chain,Family,Horizon} from '../shared/domain.js';
import {DEFAULT_RISK,DEFAULT_RULES} from '../shared/domain.js';
import {Store} from './store.js';
import {nativeUsd,usdNative,allocateUsd,percentRaw,validAddress,positive,beijingDay,usdInt,usdFloat} from './money.js';
import {entryBlock,validateEntry,validateRules} from './risk.js';

export interface OrderInput {clientId:string;accountId:string;token:string;side:'buy'|'sell';kind?:'market'|'limit';amountUsd?:number;positionId?:string;tokenAmountRaw?:string;limitPriceUsd?:number;slippagePct?:number;rules?:ExitRules;reason:string;source?:string;signalAt?:number;targets?:number[];maxEntryPriceUsd?:number;signalExpiresAt?:number;}
export interface BrokerClock {now():number;monotonic():number;}
export interface BrokerOptions {clock?:BrokerClock;}
export interface PreparedEntry {reference:Quote;reverse:Quote;}
const DEFAULT_CLOCK:BrokerClock={now:()=>Date.now(),monotonic:()=>performance.now()};
const MAX_QUOTE_AGE=5000;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Admission=Pick<PaperOrder,'admissionRevision'|'riskFingerprint'|'strategyVersion'|'strategyContext'>;
const sumFees=(q:Quote)=>q.fees.gasUsd+q.fees.approvalUsd+q.fees.protocolUsd+q.fees.taxUsd+q.fees.conversionUsd;
const outsideFees=(q:Quote)=>q.fees.gasUsd+q.fees.approvalUsd;
const ACTIVE=new Set(['waiting','queued','quoting']);
export class Broker {
 busy=false;stopped=false;risk:RiskConfig;readonly openedAt:number;lastEquity=0;lastValuation=0;readonly inFlight=new Set<string>();private submitting=new Map<string,{signature:string;promise:Promise<PaperOrder>}>();
 private generation=0;private deadlines=new Map<string,{generation:number;mono:number}>();private quoteTimes=new Map<string,{generation:number;started:number}>();private readonly clock:BrokerClock;
 constructor(readonly store:Store,readonly gateway:MarketGateway,readonly changed:()=>void=()=>{},options:BrokerOptions={}) {this.clock=options.clock??DEFAULT_CLOCK;this.openedAt=this.now();this.risk=store.meta<RiskConfig>('risk')??structuredClone(DEFAULT_RISK);this.initialise();}
 private now(){return this.clock.now();}
 get activeSubmissions(){return this.submitting.size;}
 invalidateGeneration(reason='恢复或停止使旧请求失效'){this.generation++;this.deadlines.clear();this.quoteTimes.clear();for(const o of this.orders().filter(o=>ACTIVE.has(o.status)))if(!this.inFlight.has(o.id))this.cancel(o.id,reason);return this.generation;}
 private assertGeneration(generation:number){if(this.stopped||generation!==this.generation)throw Error('旧请求已失效：正在恢复、停止或切换数据');}
 private freshAge(at:number,max:number){const age=this.now()-at;return Number.isFinite(at)&&age>=0&&age<=max;}
 private assertQuoteFresh(q:Quote){const h=this.fresh(q.chain),timing=this.quoteTimes.get(q.id);if(!this.freshAge(q.at,MAX_QUOTE_AGE)||q.block>h.head||(timing&&(timing.generation!==this.generation||this.clock.monotonic()-timing.started>MAX_QUOTE_AGE)))throw Error('报价已超过5秒或区块状态已失效，需重新报价');}
 isExperiment(s:Strategy){const baseId=this.store.meta<string>('experimentBase:'+s.id),base=baseId?this.store.get<Strategy>('strategies',baseId):undefined;return s.mode==='experiment'&&s.id==='paper-experiment-'+baseId&&s.accountId===s.id&&this.account(s.accountId).kind==='research'&&!!base&&!base.mode&&this.account(base.accountId).kind==='bot'&&base.chain===s.chain&&base.family===s.family&&base.horizon===s.horizon;}
 private admission(accountId:string):Admission {const s=this.strategies().find(s=>s.accountId===accountId);return {admissionRevision:this.store.meta<number>('admissionRevision:'+accountId)??0,riskFingerprint:hash(this.risk),strategyVersion:s?.version??null,strategyContext:s?hash({id:s.id,version:s.version,mode:s.mode??'validated',experimentBase:this.store.meta('experimentBase:'+s.id)??null,rules:s.rules,wallets:s.wallets,risk:this.risk,revision:this.store.meta('revision:'+s.id)??null}):null};}
 private assertAdmission(accountId:string,expected:Admission,rules:ExitRules){const a=this.revalueAccount(accountId),blocked=entryBlock(a,this.positions(),this.risk);if(blocked)throw Error(blocked);if(JSON.stringify(expected)!==JSON.stringify(this.admission(accountId)))throw Error('账户或策略配置已变更，旧买入请求失效');const s=this.strategies().find(s=>s.accountId===accountId);if(s?.mode==='experiment'){if(!this.isExperiment(s)||s.state!=='running'||hash(rules)!==hash(s.rules))throw Error('独立虚拟试运行已暂停或配置无效');}else if(a.kind==='bot'){const run=s?this.store.get<{status:string;promotedAt:number|null}>('research_runs',s.researchRunId??''):undefined;if(!s||s.state!=='running'||!run||run.status!=='passed'||run.promotedAt===null||hash(rules)!==hash(s.rules))throw Error('当前策略未通过验证或已暂停，旧买入请求失效');}return a;}
 private orderAdmission(o:PaperOrder):Admission {return {admissionRevision:o.admissionRevision,riskFingerprint:o.riskFingerprint,strategyVersion:o.strategyVersion,strategyContext:o.strategyContext};}
 private entryBounds(o:Pick<PaperOrder,'maxEntryPriceUsd'|'signalExpiresAt'>,q:Quote){if(o.signalExpiresAt!==undefined&&this.now()>o.signalExpiresAt)throw Error('钱包信号在成交前已过期');if(o.maxEntryPriceUsd!==undefined&&q.priceUsd>o.maxEntryPriceUsd)throw Error('新区块报价比目标买入价贵超过10%，放弃模拟入场');}
 private arm(o:PaperOrder){o.dueAt=this.now()+500;o.generation=this.generation;this.deadlines.set(o.id,{generation:this.generation,mono:this.clock.monotonic()+500});}
 private ready(o:PaperOrder){const d=this.deadlines.get(o.id),h=this.fresh(o.chain);return !!d&&d.generation===this.generation&&this.clock.monotonic()>=d.mono&&this.now()>=o.dueAt&&h.head>o.afterBlock&&h.headAt>=o.dueAt;}
 initialise(){const wallets=this.store.meta<{address:string;name:string}[]>('wallets')??[];
  for(const chain of ['bsc','robinhood'] as Chain[]){this.ensureAccount('manual-'+chain,chain==='bsc'?'手动 · BSC':'手动 · Robinhood',chain,'manual');
   for(const family of ['wallet','momentum'] as Family[])for(const horizon of ['short','swing'] as Horizon[]){const id=`${chain}-${family}-${horizon}`,name=`${chain==='bsc'?'BSC':'Robinhood'} · ${family==='wallet'?'钱包信号':'独立选币'} · ${horizon==='short'?'新盘':'波段'}`;this.ensureAccount(id,name,chain,'bot');if(!this.store.get('strategies',id))this.store.put<Strategy>('strategies',{id,name,accountId:id,chain,family,horizon,state:'waiting',reason:'等待足够的真实行情与独立验证；尚未启用',rules:{...structuredClone(DEFAULT_RULES),maxHoldMs:horizon==='short'?600000:7200000},version:'unvalidated',researchRunId:null,wallets:structuredClone(wallets),lastDecisionAt:0});}
  }
  // A process interruption cancels uncertain orders instead of inventing fills in the gap.
  for(const o of this.orders().filter(o=>o.status==='queued'||o.status==='quoting'))this.cancel(o.id,'重启后取消未完成订单；缺口期间未假定成交');
  for(const p of this.positions())if(!p.targetProgressRaw){p.targetProgressRaw=this.reconstructedProgress(p);p.doneTargets=p.rules.targets.flatMap((_,i)=>this.targetProgress(p,i)>=this.targetQuantity(p,i)?[i]:[]);this.store.put('positions',p);}
 }
 ensureAccount(id:string,name:string,chain:Chain,kind:Account['kind']){if(this.store.get('accounts',id))return;this.store.put<Account>('accounts',{id,name,chain,kind,initialCapitalUsd:100,nativeBalanceRaw:null,nativeUsd:null,cashUsd:100,equityUsd:100,conservativeEquityUsd:100,realizedUsd:0,feesUsd:0,reservedNativeRaw:'0',createdAt:this.now(),paused:false,day:beijingDay(this.now()),dayStartEquityUsd:100,dayEntries:0,dayNetUsd:0,consecutiveLosses:0,haltReason:'',dailyLatch:null});}
 accounts(){return this.store.all<Account>('accounts');}positions(){return this.store.all<Position>('positions');}orders(){return this.store.all<PaperOrder>('orders');}fills(){return this.store.all<Fill>('fills');}strategies(){return this.store.all<Strategy>('strategies');}
 recipient(accountId:string){const key='recipient:'+accountId;let a=this.store.meta<string>(key);if(!a){a='0x'+randomBytes(20).toString('hex');this.store.setMeta(key,a);}return a;}
 account(id:string):Account {const a=this.store.get<Account>('accounts',id);if(!a)throw Error('模拟账户不存在');return a;}
 head(chain:Chain){return this.gateway.statuses().find(s=>s.chain===chain);}
 fresh(chain:Chain){const h=this.head(chain);if(!h?.connected||!h.head||!this.freshAge(h.headAt,15000))throw Error('链上数据过期或未连接，暂停新订单');return h;}
 async getQuote(accountId:string,request:Parameters<MarketGateway['quote']>[0]):Promise<Quote>{const generation=this.generation,started=this.clock.monotonic();this.assertGeneration(generation);const q=await this.gateway.quote(request);this.assertGeneration(generation);if(q.chain!==request.chain||q.token!==request.token||q.side!==request.side||(request.block!==undefined&&q.block!==request.block))throw Error('报价币种、方向或区块与请求不一致');const input=BigInt(q.inputRaw),spent=BigInt(q.spentInputRaw),refund=BigInt(q.refundRaw),requested=BigInt(request.side==='buy'?request.nativeAmountRaw!:request.tokenAmountRaw!);if(input!==requested||spent<=0n||spent>input||refund!==input-spent||q.quality==='unavailable'||!q.fees.includedInOutput||!Number.isFinite(q.nativeUsd)||q.nativeUsd<=0||!Number.isFinite(q.priceUsd)||q.priceUsd<=0||BigInt(q.outputRaw)<=0n||q.fees.quality==='unavailable'||!Number.isFinite(q.priceImpactPct)||!Number.isInteger(q.tokenDecimals)||q.tokenDecimals<0||q.tokenDecimals>36||[q.fees.gasUsd,q.fees.approvalUsd,q.fees.protocolUsd,q.fees.taxUsd,q.fees.conversionUsd].some(n=>!Number.isFinite(n)||n<0))throw Error(q.reason||'报价或费用尚未核实');const copy=structuredClone(q);if(this.store.meta('approval:'+accountId+':'+q.venue+':'+q.side+':'+q.token))copy.fees.approvalUsd=0;this.quoteTimes.set(q.id,{generation,started});this.assertQuoteFresh(copy);if(this.quoteTimes.size>10000)this.quoteTimes.delete(this.quoteTimes.keys().next().value!);this.store.quote(copy);return copy;}
 markApproval(accountId:string,q:Quote){if(q.fees.approvalUsd>0)this.store.setMeta('approval:'+accountId+':'+q.venue+':'+q.side+':'+q.token,true);}
 fundNative(accountId:string,fx:number,generation=this.generation){this.assertGeneration(generation);const a=this.account(accountId);if(a.nativeBalanceRaw===null){a.nativeBalanceRaw=usdNative(a.initialCapitalUsd,fx).toString();a.nativeUsd=fx;this.store.put('accounts',a);this.store.setMeta('depositFx:'+a.id,fx);this.store.ledger(a.id,null,'native',BigInt(a.nativeBalanceRaw),BigInt(a.nativeBalanceRaw),'初始100美元虚拟本金按首次可核实汇率计为报价币');}return a;}
 async quoteBudget(accountId:string,token:string,totalBudget:number,block:number,background=false){const account=this.account(accountId),market=this.gateway.getMarket(account.chain,token);if(!market?.nativeUsd)throw Error('报价币汇率未知');let q=await this.getQuote(accountId,{chain:account.chain,token,side:'buy',recipient:this.recipient(accountId),nativeAmountRaw:usdNative(totalBudget,market.nativeUsd).toString(),block,background});const extra=outsideFees(q);if(extra>=totalBudget)throw Error('费用已超过虚拟入场预算');if(extra>0)q=await this.getQuote(accountId,{chain:account.chain,token,side:'buy',recipient:this.recipient(accountId),nativeAmountRaw:(usdNative(totalBudget,q.nativeUsd)-usdNative(extra,q.nativeUsd,true)).toString(),block,background});return q;}
 async submit(input:OrderInput,prepared?:PreparedEntry):Promise<PaperOrder>{
  const signature=JSON.stringify({accountId:input.accountId,token:input.token?.toLowerCase(),side:input.side,kind:input.kind??'market',amountUsd:input.amountUsd??null,positionId:input.positionId??null,tokenAmountRaw:input.tokenAmountRaw??null,limitPriceUsd:input.limitPriceUsd??null,slippagePct:input.slippagePct??3,rules:input.rules??DEFAULT_RULES,reason:input.reason,source:input.source??'manual',targets:input.targets??[],signalAt:input.signalAt??null,maxEntryPriceUsd:input.maxEntryPriceUsd??null,signalExpiresAt:input.signalExpiresAt??null});
  const previous=this.store.meta<string>('orderSignature:'+input.clientId);if(previous&&previous!==signature)throw Error('相同订单标识不能修改金额或规则');
  const pending=this.submitting.get(input.clientId);if(pending){if(pending.signature!==signature)throw Error('相同订单标识不能修改金额或规则');return pending.promise;}
  const promise=this.submitOrder(input,signature,this.generation,prepared);this.submitting.set(input.clientId,{signature,promise});try{return await promise;}finally{this.submitting.delete(input.clientId);}
 }
 private async submitOrder(input:OrderInput,signature:string,generation:number,prepared?:PreparedEntry):Promise<PaperOrder>{
  this.assertGeneration(generation);if(typeof input.clientId!=='string'||!/^[A-Za-z0-9:_-]{8,128}$/.test(input.clientId))throw Error('订单标识无效');
  const existing=this.orders().find(o=>o.clientId===input.clientId);if(existing){if(existing.accountId!==input.accountId||existing.token!==validAddress(input.token)||existing.side!==input.side)throw Error('重复标识对应不同订单');return existing;}
  const account=this.account(input.accountId),token=validAddress(input.token),head=this.fresh(account.chain),side=input.side;
  if(side!=='buy'&&side!=='sell')throw Error('买卖方向无效');if(input.kind&&input.kind!=='market'&&input.kind!=='limit')throw Error('订单类型无效');if(typeof input.reason!=='string'||input.reason.trim().length<2||input.reason.length>500)throw Error('请填写具体买卖理由');
  const rules=validateRules(input.rules??DEFAULT_RULES),slippage=input.slippagePct??3,kind=input.kind??'market';if(!Number.isFinite(slippage)||slippage<0||slippage>30)throw Error('模拟滑点容忍须在0到30%之间');if(kind==='limit')positive(input.limitPriceUsd,'限价');
  if(input.maxEntryPriceUsd!==undefined)positive(input.maxEntryPriceUsd,'买价上限');if(input.signalExpiresAt!==undefined&&!Number.isFinite(input.signalExpiresAt))throw Error('信号期限无效');
  const admission=this.admission(account.id),recipient=this.recipient(account.id);let reference:Quote,reverse:Quote|undefined,position:Position|undefined,amountUsd:number|null=null,tokenRaw:string|null=null;
  if(side==='buy'){
   this.assertAdmission(account.id,admission,rules);amountUsd=positive(input.amountUsd,'买入金额');const m=this.gateway.getMarket(account.chain,token);if(!m?.nativeUsd)throw Error('报价币美元价格尚未核实');
   if(prepared){
    reference=structuredClone(prepared.reference);reverse=structuredClone(prepared.reverse);
    if(!this.quoteTimes.has(reference.id)||!this.quoteTimes.has(reverse.id)||reference.chain!==account.chain||reference.token!==token||reference.side!=='buy'||reverse.side!=='sell'||reverse.chain!==reference.chain||reverse.token!==reference.token||reverse.block!==reference.block||reverse.inputRaw!==reference.outputRaw||Math.abs(nativeUsd(reference.inputRaw,reference.nativeUsd)-amountUsd)>1e-6)throw Error('共享入场报价与订单不一致或未在本进程核实');
   }else{
    reference=await this.getQuote(account.id,{chain:account.chain,token,side,recipient,nativeAmountRaw:usdNative(amountUsd,m.nativeUsd).toString(),block:head.head});
    reverse=await this.getQuote(account.id,{chain:account.chain,token,side:'sell',recipient,tokenAmountRaw:reference.outputRaw,block:reference.block});
   }
   this.assertGeneration(generation);this.assertQuoteFresh(reference);this.assertQuoteFresh(reverse);this.assertAdmission(account.id,admission,rules);this.entryBounds(input,reference);validateEntry(this.account(account.id),reference,reverse,rules,this.risk,slippage);
  }else{
   position=this.store.get<Position>('positions',input.positionId??'');if(!position||position.accountId!==account.id||position.token!==token||position.closedAt||BigInt(position.remainingRaw)<=0n)throw Error('请选择这个账户的未平仓批次');if(position.pendingOrderId)throw Error('该批次已有卖出订单');
   tokenRaw=input.tokenAmountRaw??position.remainingRaw;if(!/^\d{1,78}$/.test(tokenRaw)||BigInt(tokenRaw)<=0n||BigInt(tokenRaw)>BigInt(position.remainingRaw))throw Error('卖出数量超过当前余仓或无效');
   if(input.targets&&(!Array.isArray(input.targets)||new Set(input.targets).size!==input.targets.length||input.targets.some(i=>!Number.isInteger(i)||i<0||i>=position!.rules.targets.length)))throw Error('止盈档位无效');
   reference=await this.getQuote(account.id,{chain:account.chain,token,side,recipient,tokenAmountRaw:tokenRaw,block:head.head});
  }
  this.assertGeneration(generation);this.assertQuoteFresh(reference);
  const now=this.now(),o:PaperOrder={id:randomUUID(),clientId:input.clientId,accountId:account.id,chain:account.chain,token,positionId:position?.id??null,side,kind,amountUsd,tokenAmountRaw:tokenRaw,limitPriceUsd:kind==='limit'?input.limitPriceUsd!:null,slippagePct:slippage,status:kind==='limit'?'waiting':'queued',createdAt:now,signalAt:input.signalAt??null,decisionAt:now,dueAt:now+500,afterBlock:reference.block,filledAt:null,referenceQuote:reference,fillQuote:null,reservedNativeRaw:'0',rules,reason:input.reason.trim(),error:'',source:input.source??'manual',targets:input.targets??[],maxEntryPriceUsd:input.maxEntryPriceUsd,signalExpiresAt:input.signalExpiresAt,generation,...admission};
  this.store.transaction(()=>{
   this.assertGeneration(generation);let a=this.account(account.id);
   if(side==='buy'){
    a=this.assertAdmission(a.id,admission,rules);this.entryBounds(o,reference);validateEntry(a,reference,reverse!,rules,this.risk,slippage);
    const pending=this.orders().filter(x=>x.accountId===a.id&&x.side==='buy'&&ACTIVE.has(x.status));
    if(pending.length+this.positions().filter(p=>p.accountId===a.id&&!p.closedAt).length>=this.risk.maxPositions)throw Error('未成交订单与持仓已达到数量上限');if(pending.length+a.dayEntries>=this.risk.dailyEntries)throw Error('含待成交订单已达到当天开仓限制');
    a=this.fundNative(a.id,reference.nativeUsd,generation);const reserve=BigInt(reference.inputRaw)+usdNative(outsideFees(reference)*1.5,reference.nativeUsd,true);
    if(BigInt(a.nativeBalanceRaw??'0')-BigInt(a.reservedNativeRaw)<reserve)throw Error('可用虚拟余额不足（含冻结金额与费用）');o.reservedNativeRaw=String(reserve);a.reservedNativeRaw=String(BigInt(a.reservedNativeRaw)+reserve);this.store.put('accounts',a);
   }else{
    const p=this.store.get<Position>('positions',position!.id)!;if(!p||p.closedAt||p.pendingOrderId||BigInt(tokenRaw!)>BigInt(p.remainingRaw))throw Error('该批次已有卖出订单或数量已变化');p.pendingOrderId=o.id;this.store.put('positions',p);
   }
   if(o.status==='queued')this.arm(o);this.store.put('orders',o);this.store.setMeta('orderSignature:'+input.clientId,signature);this.store.audit('order','创建虚拟'+(side==='buy'?'买入':'卖出')+'订单',{id:o.id,account:o.accountId,reason:o.reason});
  });this.changed();return o;
 }
 release(o:PaperOrder){const a=this.account(o.accountId),reserved=BigInt(a.reservedNativeRaw)-BigInt(o.reservedNativeRaw);if(reserved<0n)throw Error('冻结余额对账失败');a.reservedNativeRaw=String(reserved);o.reservedNativeRaw='0';this.store.put('accounts',a);if(o.positionId){const p=this.store.get<Position>('positions',o.positionId);if(p?.pendingOrderId===o.id){p.pendingOrderId=null;this.store.put('positions',p);}}}
 cancel(id:string,reason='手动取消虚拟订单'){const o=this.store.get<PaperOrder>('orders',id);if(!o||!ACTIVE.has(o.status))return o;if(this.inFlight.has(id))throw Error('订单报价处理中，稍后取消');this.store.transaction(()=>{this.release(o);o.status='cancelled';o.error=reason;this.store.put('orders',o);this.store.audit('cancel',reason,{orderId:id});});this.deadlines.delete(id);this.changed();return o;}
 fail(order:PaperOrder,message:string,q?:Quote,chargeGas=false){
  this.store.transaction(()=>{const o=this.store.get<PaperOrder>('orders',order.id);if(!o||!ACTIVE.has(o.status))return;this.release(o);o.status='failed';o.error=message;o.fillQuote=q??null;this.store.put('orders',o);let chargedGas=false;
   if(chargeGas&&q){const a=this.account(o.accountId),cost=usdNative(outsideFees(q),q.nativeUsd,true),balance=BigInt(a.nativeBalanceRaw??'0'),available=balance-BigInt(a.reservedNativeRaw);
    if(cost<=available){a.nativeBalanceRaw=String(balance-cost);const actual=nativeUsd(cost,q.nativeUsd);a.realizedUsd=usdFloat(usdInt(a.realizedUsd)-usdInt(actual));a.dayNetUsd=usdFloat(usdInt(a.dayNetUsd)-usdInt(actual));a.feesUsd=usdFloat(usdInt(a.feesUsd)+usdInt(actual));this.store.put('accounts',a);this.store.ledger(a.id,o.id,'native',-cost,balance-cost,'模拟链上失败费用；非真实交易');this.markApproval(a.id,q);chargedGas=true;}
    else{o.error+='；可用余额不足以支付模拟Gas，未模拟广播或扣费';this.store.put('orders',o);}
   }this.store.audit('failed',o.error,{orderId:o.id,simulatedGas:chargedGas});
  });this.deadlines.delete(order.id);this.revalueAccount(order.accountId);this.changed();
 }
 private partialRiskOverride(o:PaperOrder){if(o.side!=='sell'||!o.positionId)return false;const p=this.store.get<Position>('positions',o.positionId);if(!p||p.closedAt)return false;const d=this.exitDecision(p);return !!d?.clear&&!(o.source==='risk'&&o.targets.length===0&&BigInt(o.tokenAmountRaw!)>=BigInt(p.remainingRaw));}
 async execute(order:PaperOrder){
  if(this.inFlight.has(order.id)||this.stopped)return;this.inFlight.add(order.id);const generation=this.generation;
  try{
   const o=this.store.get<PaperOrder>('orders',order.id);if(!o||o.status!=='queued')return;if(o.generation!==generation)throw Error('旧订单请求已失效');if(!this.ready(o))return;
   if(o.side==='buy')this.assertAdmission(o.accountId,this.orderAdmission(o),o.rules);
   if(this.partialRiskOverride(o)){this.fail(o,'清仓风控优先于原卖出订单');this.store.setMeta('exitRetry:'+o.positionId,0);await this.evaluateExits();return;}
   this.assertQuoteFresh(o.referenceQuote!);const head=this.fresh(o.chain);o.status='quoting';this.store.put('orders',o);
   const q=await this.getQuote(o.accountId,{chain:o.chain,token:o.token,side:o.side,recipient:this.recipient(o.accountId),block:head.head,...(o.side==='buy'?{nativeAmountRaw:o.referenceQuote!.inputRaw}:{tokenAmountRaw:o.tokenAmountRaw!})});
   this.assertGeneration(generation);if(!this.ready(o)||q.block!==head.head||q.block<=o.afterBlock)throw Error('没有取得延迟后新区块的有效报价');
   if(o.side==='buy'){this.assertAdmission(o.accountId,this.orderAdmission(o),o.rules);this.entryBounds(o,q);}
   const r=o.referenceQuote!,slip=BigInt(Math.round((100-o.slippagePct)*10000)),lhs=BigInt(q.outputRaw)*BigInt(r.spentInputRaw)*1000000n,rhs=BigInt(r.outputRaw)*BigInt(q.spentInputRaw)*slip;
   if(lhs<rhs){this.fail(o,'新区块报价超出滑点容忍，模拟成交失败',q,true);return;}
   if(o.limitPriceUsd!==null&&((o.side==='buy'&&q.priceUsd>o.limitPriceUsd)||(o.side==='sell'&&q.priceUsd<o.limitPriceUsd))){this.fail(o,'新区块实际报价未满足限价',q,true);return;}
   let reverse:Quote|undefined,residual:Quote|undefined;
   if(o.side==='buy')reverse=await this.getQuote(o.accountId,{chain:o.chain,token:o.token,side:'sell',recipient:this.recipient(o.accountId),tokenAmountRaw:q.outputRaw,block:q.block});
   else{const p=this.store.get<Position>('positions',o.positionId!)!,remaining=BigInt(p.remainingRaw)-BigInt(q.spentInputRaw);if(remaining>0n)try{residual=await this.getQuote(o.accountId,{chain:o.chain,token:o.token,side:'sell',recipient:this.recipient(o.accountId),tokenAmountRaw:String(remaining),block:q.block});}catch{this.assertGeneration(generation);}}
   this.assertGeneration(generation);this.assertQuoteFresh(q);if(reverse)this.assertQuoteFresh(reverse);if(residual)this.assertQuoteFresh(residual);
   if(this.partialRiskOverride(o)){this.fail(o,'报价期间触发清仓风控，旧分批卖出失效');this.store.setMeta('exitRetry:'+o.positionId,0);await this.evaluateExits();return;}
   this.applyFill(o,q,reverse,generation,residual);
  }catch(e){const o=this.store.get<PaperOrder>('orders',order.id);if(o&&ACTIVE.has(o.status)&&o.generation===generation)this.fail(o,e instanceof Error?e.message:'报价失败');}
  finally{this.inFlight.delete(order.id);}
 }
 applyFill(order:PaperOrder,q:Quote,reverse?:Quote,generation=this.generation,residual?:Quote){
  this.store.transaction(()=>{
   this.assertGeneration(generation);const o=this.store.get<PaperOrder>('orders',order.id);if(!o||o.status!=='quoting')return;if(o.generation!==generation||!this.ready(o))throw Error('成交的延迟、区块或请求版本不再有效');
   this.assertQuoteFresh(q);if(o.chain!==q.chain||o.token!==q.token||o.side!==q.side||q.block<=o.afterBlock||BigInt(q.inputRaw)!==BigInt(o.side==='buy'?o.referenceQuote!.inputRaw:o.tokenAmountRaw!))throw Error('报价与虚拟订单不匹配');
   if(o.side==='buy'){if(!reverse)throw Error('缺少当前整仓反向报价，无法核验入场风险');this.assertQuoteFresh(reverse);this.assertAdmission(o.accountId,this.orderAdmission(o),o.rules);this.entryBounds(o,q);validateEntry(this.account(o.accountId),q,reverse,o.rules,this.risk,o.slippagePct);}
   const a=this.account(o.accountId),extra=usdNative(outsideFees(q),q.nativeUsd,true),balance=BigInt(a.nativeBalanceRaw??'0'),otherReservations=BigInt(a.reservedNativeRaw)-BigInt(o.reservedNativeRaw);let p:Position,tokenQty:bigint,cashDelta:bigint,basis=0,net=0,usd=0;
   if(otherReservations<0n||balance-otherReservations<extra)throw Error('可用虚拟余额不足以先支付Gas或授权费用');
   if(o.side==='buy'){
    tokenQty=BigInt(q.outputRaw);cashDelta=-(BigInt(q.spentInputRaw)+extra);if(balance+cashDelta<otherReservations)throw Error('费用变化后可用虚拟余额不足，不能使用其他订单冻结资金');usd=nativeUsd(-cashDelta,q.nativeUsd);const market=this.gateway.getMarket(o.chain,o.token);
    p={id:randomUUID(),accountId:a.id,chain:o.chain,token:o.token,symbol:market?.symbol??o.token.slice(0,8),originalRaw:String(tokenQty),remainingRaw:String(tokenQty),decimals:q.tokenDecimals,entryPriceUsd:q.priceUsd,costNativeRaw:String(-cashDelta),costUsd:usd,remainingCostUsd:usd,cashBackUsd:0,netRealizedUsd:0,openedAt:this.now(),closedAt:null,rules:o.rules,doneTargets:[],peakPriceUsd:q.priceUsd,lastPriceUsd:reverse!.priceUsd,liquidationUsd:Math.max(0,nativeUsd(reverse!.outputRaw,reverse!.nativeUsd)-outsideFees(reverse!)),valuationAt:this.now(),valuationReason:'同一区块整仓反向报价（含卖出费用）',pendingOrderId:null,source:o.source,reason:o.reason,targetProgressRaw:{}};
    p.doneTargets=p.rules.targets.flatMap((_,i)=>this.targetQuantity(p,i)===0n?[i]:[]);o.positionId=p.id;a.dayEntries++;
   }else{
    p=this.store.get<Position>('positions',o.positionId!)!;if(!p||p.closedAt||p.pendingOrderId!==o.id)throw Error('该批次已经结束或订单归属已变化');tokenQty=BigInt(q.spentInputRaw);const remaining=BigInt(p.remainingRaw);if(tokenQty<=0n||tokenQty>remaining)throw Error('卖出数量超过余仓');cashDelta=BigInt(q.outputRaw)-extra;if(balance+cashDelta<otherReservations)throw Error('卖出费用不能使用其他订单的冻结资金');
    basis=tokenQty===remaining?p.remainingCostUsd:allocateUsd(p.remainingCostUsd,tokenQty,remaining);usd=usdFloat(usdInt(nativeUsd(q.outputRaw,q.nativeUsd)-outsideFees(q)));net=usdFloat(usdInt(usd)-usdInt(basis));p.remainingRaw=String(remaining-tokenQty);p.remainingCostUsd=usdFloat(usdInt(p.remainingCostUsd)-usdInt(basis));p.cashBackUsd=usdFloat(usdInt(p.cashBackUsd)+usdInt(usd));p.netRealizedUsd=usdFloat(usdInt(p.netRealizedUsd)+usdInt(net));p.pendingOrderId=null;this.creditTargets(p,o.targets,tokenQty);
    p.liquidationUsd=null;p.valuationAt=null;p.valuationReason='卖出后等待余仓报价';
    if(residual&&BigInt(residual.inputRaw)===BigInt(p.remainingRaw)&&residual.spentInputRaw===residual.inputRaw&&residual.block===q.block){p.liquidationUsd=Math.max(0,nativeUsd(residual.outputRaw,residual.nativeUsd)-outsideFees(residual));p.valuationAt=this.now();p.lastPriceUsd=residual.priceUsd;p.valuationReason='同一区块剩余仓位报价（含卖出费用）';}
    if(BigInt(p.remainingRaw)===0n){p.closedAt=this.now();p.remainingCostUsd=0;p.liquidationUsd=0;a.consecutiveLosses=p.netRealizedUsd<0?a.consecutiveLosses+1:0;}a.realizedUsd=usdFloat(usdInt(a.realizedUsd)+usdInt(net));a.dayNetUsd=usdFloat(usdInt(a.dayNetUsd)+usdInt(net));
   }
   this.release(o);a.reservedNativeRaw=this.account(a.id).reservedNativeRaw;a.nativeBalanceRaw=String(balance+cashDelta);a.nativeUsd=q.nativeUsd;a.feesUsd=usdFloat(usdInt(a.feesUsd)+usdInt(sumFees(q)));this.store.put('accounts',a);this.store.put('positions',p);
   const fill:Fill={id:randomUUID(),orderId:o.id,accountId:a.id,positionId:p.id,chain:o.chain,token:o.token,side:o.side,tokenRaw:String(tokenQty),nativeRaw:String(o.side==='buy'?BigInt(q.spentInputRaw):BigInt(q.outputRaw)),usd,costBasisUsd:basis,netUsd:net,fees:q.fees,at:this.now(),block:q.block,priceUsd:q.priceUsd,reason:o.reason};this.store.put('fills',fill);
   this.store.ledger(a.id,o.id,'native',cashDelta,balance+cashDelta,o.side==='buy'?'虚拟买入及额外费用':'虚拟卖出扣额外费用');this.store.ledger(a.id,o.id,o.token,o.side==='buy'?tokenQty:-tokenQty,balance+cashDelta,'代币批次数量变动');this.markApproval(a.id,q);
   o.fillQuote=q;o.filledAt=fill.at;o.status=BigInt(q.refundRaw)>0n?'partial':'filled';o.reservedNativeRaw='0';this.store.put('orders',o);this.store.audit('fill','虚拟成交已记账',{orderId:o.id,block:q.block,feesEstimated:q.fees.quality==='estimated',timing:{signal:o.signalAt,decision:o.decisionAt,quoted:q.at,filled:fill.at},venue:q.venue});
  });this.deadlines.delete(order.id);this.revalueAccount(order.accountId);this.changed();
 }
 private targetQuantity(p:Position,index:number){const previous=p.rules.targets.slice(0,index).reduce((n,t)=>n+t.sellOriginalPct,0),current=previous+p.rules.targets[index].sellOriginalPct;return percentRaw(p.originalRaw,Math.min(100,current))-percentRaw(p.originalRaw,Math.min(100,previous));}
 private targetProgress(p:Position,index:number){return BigInt(p.targetProgressRaw?.[index]??(p.doneTargets.includes(index)?String(this.targetQuantity(p,index)):'0'));}
 private creditTargets(p:Position,targets:number[],sold:bigint){p.targetProgressRaw??={};for(const i of [...targets].sort((a,b)=>a-b)){const goal=this.targetQuantity(p,i),previous=this.targetProgress(p,i),wanted=goal-previous,take=sold<wanted?sold:wanted;if(take<0n)throw Error('止盈进度超过原仓目标');p.targetProgressRaw[i]=String(previous+take);sold-=take;}p.doneTargets=p.rules.targets.flatMap((_,i)=>this.targetProgress(p,i)>=this.targetQuantity(p,i)?[i]:[]);}
 private reconstructedProgress(p:Position,positionFills=this.fills().filter(f=>f.positionId===p.id),orders?:Map<string,PaperOrder>){const copy={...p,doneTargets:[],targetProgressRaw:{} as Record<string,string>};for(const f of positionFills.filter(f=>f.side==='sell')){const o=orders?orders.get(f.orderId):this.store.get<PaperOrder>('orders',f.orderId);if(o?.targets)this.creditTargets(copy,o.targets,BigInt(f.tokenRaw));}return copy.targetProgressRaw;}
 revalueAccount(id:string){
  const a=this.account(id),market=this.gateway.markets().find(m=>m.chain===a.chain&&m.nativeUsd);if(market?.nativeUsd)a.nativeUsd=market.nativeUsd;if(a.nativeBalanceRaw!==null&&a.nativeUsd)a.cashUsd=nativeUsd(a.nativeBalanceRaw,a.nativeUsd);else a.cashUsd=a.initialCapitalUsd;
  let upper=0,lower=0,unknown=false;for(const p of this.positions().filter(p=>p.accountId===id&&!p.closedAt)){
   const value=p.liquidationUsd;if(value!==null&&p.valuationAt!==null&&this.freshAge(p.valuationAt,MAX_QUOTE_AGE)&&this.head(p.chain)?.connected){upper+=value;lower+=Math.max(0,value);}else{unknown=true;const m=this.gateway.getMarket(p.chain,p.token),price=m?.priceUsd??p.lastPriceUsd??p.entryPriceUsd;upper+=Number(BigInt(p.remainingRaw))/10**p.decimals*price;}
  }
  a.equityUsd=usdFloat(usdInt(a.cashUsd+upper));a.conservativeEquityUsd=usdFloat(usdInt(a.cashUsd+lower));
  if(a.day!==beijingDay(this.now())){a.day=beijingDay(this.now());a.dayStartEquityUsd=a.conservativeEquityUsd;a.dayEntries=0;a.dayNetUsd=0;a.consecutiveLosses=0;a.haltReason='';a.dailyLatch=null;}
  // Missing liquidation data pauses admission; it does not prove a daily loss.
  if(!a.dailyLatch){if(a.consecutiveLosses>=this.risk.maxConsecutiveLosses)a.dailyLatch='连续净亏损达到限制';else if(a.dayNetUsd<=-a.dayStartEquityUsd*this.risk.dailyLossPct/100||(!unknown&&a.conservativeEquityUsd<=a.dayStartEquityUsd*(1-this.risk.dailyLossPct/100)))a.dailyLatch='当天净亏损达到限制';}
  a.haltReason=a.dailyLatch??entryBlock({...a,haltReason:'',paused:false},[],this.risk)??'';this.store.put('accounts',a);return a;
 }
 async updateValuations(){
  const generation=this.generation;for(const p of this.positions().filter(p=>!p.closedAt)){
   try{this.assertGeneration(generation);const head=this.fresh(p.chain),q=await this.getQuote(p.accountId,{chain:p.chain,token:p.token,side:'sell',recipient:this.recipient(p.accountId),tokenAmountRaw:p.remainingRaw,block:head.head});this.assertGeneration(generation);this.assertQuoteFresh(q);const current=this.store.get<Position>('positions',p.id)!;if(current.remainingRaw!==p.remainingRaw||current.closedAt)continue;const complete=q.spentInputRaw===q.inputRaw;current.liquidationUsd=complete?Math.max(0,nativeUsd(q.outputRaw,q.nativeUsd)-outsideFees(q)):null;current.valuationAt=complete?this.now():null;current.valuationReason=complete?q.fees.notes.join('；'):'只能部分卖出，等待整仓可卖报价';current.lastPriceUsd=q.priceUsd;current.peakPriceUsd=Math.max(current.peakPriceUsd,q.priceUsd);this.store.put('positions',current);}
   catch(e){if(generation!==this.generation||this.stopped)return;const current=this.store.get<Position>('positions',p.id);if(current&&!current.closedAt){current.liquidationUsd=null;current.valuationAt=null;current.valuationReason=e instanceof Error?e.message:'当前无法取得可卖报价';this.store.put('positions',current);}}
  }
 }
 private exitDecision(p:Position):{clear:boolean;reason:string;targets:number[];quantity:bigint}|null{
  const h=this.head(p.chain);if(!h?.connected||!this.freshAge(h.headAt,15000))return null;const m=this.gateway.getMarket(p.chain,p.token),valuationFresh=p.valuationAt!==null&&this.freshAge(p.valuationAt,MAX_QUOTE_AGE),price=m?.priceUsd&&m.quality!=='unavailable'&&this.freshAge(m.updatedAt,MAX_QUOTE_AGE)?m.priceUsd:valuationFresh?p.lastPriceUsd:null,timeout=this.now()-p.openedAt>=p.rules.maxHoldMs;if(!price&&!timeout)return null;
  const gain=price?100*(price/p.entryPriceUsd-1):0,reduced=BigInt(p.remainingRaw)<BigInt(p.originalRaw);let reason='';
  if(price&&gain<=-p.rules.stopPct)reason='止损：当前价格相对入场跌'+p.rules.stopPct+'%';
  else if(price&&reduced&&p.rules.trailPct&&price<=p.peakPriceUsd*(1-p.rules.trailPct/100))reason='移动退出：从峰值回落'+p.rules.trailPct+'%';
  else if(reduced&&p.rules.protectBreakeven&&valuationFresh&&p.liquidationUsd!==null&&p.liquidationUsd<=p.remainingCostUsd)reason='首次减仓后保护剩余成本（已计估计卖出费用）';
  else if(timeout)reason='达到最长持有时间，按恢复后当前报价退出';
  if(reason)return {clear:true,reason,targets:[],quantity:BigInt(p.remainingRaw)};
  const targets=price?p.rules.targets.flatMap((t,i)=>!p.doneTargets.includes(i)&&(gain>=t.gainPct||this.targetProgress(p,i)>0n)?[i]:[]):[],requested=targets.reduce((n,i)=>n+this.targetQuantity(p,i)-this.targetProgress(p,i),0n),quantity=requested<BigInt(p.remainingRaw)?requested:BigInt(p.remainingRaw);
  return quantity>0n?{clear:false,reason:'分批止盈：按最初仓位补齐未完成档位',targets,quantity}:null;
 }
 async evaluateExits(){
  if(this.stopped)return;for(const initial of this.positions().filter(p=>!p.closedAt)){
   const p=this.store.get<Position>('positions',initial.id)!;const m=this.gateway.getMarket(p.chain,p.token);if(m?.priceUsd&&m.quality!=='unavailable'&&this.freshAge(m.updatedAt,MAX_QUOTE_AGE)&&m.priceUsd>p.peakPriceUsd){p.peakPriceUsd=m.priceUsd;this.store.put('positions',p);}const d=this.exitDecision(p);if(!d)continue;
   let replacing=false;if(p.pendingOrderId){const pending=this.store.get<PaperOrder>('orders',p.pendingOrderId);if(d.clear&&pending&&!this.inFlight.has(pending.id)&&!(pending.source==='risk'&&pending.targets.length===0&&BigInt(pending.tokenAmountRaw!)>=BigInt(p.remainingRaw))){this.cancel(pending.id,'清仓风控优先于原卖出订单');replacing=true;}else continue;}
   const retry=this.store.meta<number>('exitRetry:'+p.id)??0;if(!replacing&&this.now()-retry<3000)continue;this.store.setMeta('exitRetry:'+p.id,this.now());
   try{await this.submit({clientId:'exit:'+p.id+':'+randomUUID(),accountId:p.accountId,token:p.token,positionId:p.id,side:'sell',tokenAmountRaw:String(d.quantity),rules:p.rules,reason:d.reason,source:'risk',targets:d.targets});}catch(e){this.store.audit('exit_blocked','退出未能成交，保留余仓',{positionId:p.id,reason:e instanceof Error?e.message:'报价未取得'});}
  }
 }
 private async triggerLimit(o:PaperOrder){
  const generation=this.generation;try{
   if(o.side==='buy')this.assertAdmission(o.accountId,this.orderAdmission(o),o.rules);const head=this.fresh(o.chain),q=await this.getQuote(o.accountId,{chain:o.chain,token:o.token,side:o.side,recipient:this.recipient(o.accountId),block:head.head,...(o.side==='buy'?{nativeAmountRaw:o.referenceQuote!.inputRaw}:{tokenAmountRaw:o.tokenAmountRaw!})});
   this.assertGeneration(generation);if(o.limitPriceUsd===null||(o.side==='buy'?q.priceUsd>o.limitPriceUsd:q.priceUsd<o.limitPriceUsd))return;let reverse:Quote|undefined;if(o.side==='buy')reverse=await this.getQuote(o.accountId,{chain:o.chain,token:o.token,side:'sell',recipient:this.recipient(o.accountId),tokenAmountRaw:q.outputRaw,block:q.block});this.assertGeneration(generation);this.assertQuoteFresh(q);
   this.store.transaction(()=>{const current=this.store.get<PaperOrder>('orders',o.id);if(!current||current.status!=='waiting')return;if(o.side==='buy'){const a=this.assertAdmission(o.accountId,this.orderAdmission(o),o.rules);this.entryBounds(o,q);validateEntry(a,q,reverse!,o.rules,this.risk,o.slippagePct);const reserve=BigInt(q.inputRaw)+usdNative(outsideFees(q)*1.5,q.nativeUsd,true),other=BigInt(a.reservedNativeRaw)-BigInt(current.reservedNativeRaw);if(BigInt(a.nativeBalanceRaw??'0')-other<reserve)throw Error('限价触发时虚拟余额不足');a.reservedNativeRaw=String(other+reserve);current.reservedNativeRaw=String(reserve);this.store.put('accounts',a);}current.referenceQuote=q;current.afterBlock=q.block;current.status='queued';this.arm(current);this.store.put('orders',current);});
  }catch(e){if(generation===this.generation)this.fail(o,e instanceof Error?e.message:'限价触发报价失败');}
 }
 async tick(){
  if(this.busy||this.stopped)return;this.busy=true;try{
   await this.evaluateExits();
   for(const o of this.orders().filter(o=>o.status==='waiting')){const m=this.gateway.getMarket(o.chain,o.token);if(m?.priceUsd&&m.quality!=='unavailable'&&this.freshAge(m.updatedAt,MAX_QUOTE_AGE)&&o.limitPriceUsd!==null&&((o.side==='buy'&&m.priceUsd<=o.limitPriceUsd)||(o.side==='sell'&&m.priceUsd>=o.limitPriceUsd)))await this.triggerLimit(o);}
   await this.evaluateExits();for(const o of this.orders().filter(o=>o.status==='queued'))await this.execute(o);
   if(this.now()-this.lastValuation>=5000){this.lastValuation=this.now();await this.updateValuations();}await this.evaluateExits();for(const a of this.accounts())this.revalueAccount(a.id);
   if(this.now()-this.lastEquity>=30000){this.lastEquity=this.now();for(const a of this.accounts())this.store.equity(a.id,a.equityUsd,a.conservativeEquityUsd);}this.changed();
  }finally{this.busy=false;}
 }
 pauseAccount(id:string,paused:boolean){const a=this.account(id);a.paused=paused;this.store.setMeta('admissionRevision:'+id,(this.store.meta<number>('admissionRevision:'+id)??0)+1);this.store.put('accounts',a);if(paused)for(const o of this.orders().filter(o=>o.accountId===id&&o.side==='buy'&&ACTIVE.has(o.status)))if(!this.inFlight.has(o.id))this.cancel(o.id,'暂停新仓时取消买入订单');this.changed();return a;}
 checks(){
  const accounts=this.accounts(),positions=this.positions(),orders=this.orders(),fills=this.fills(),errors:string[]=[];
  const rows=this.store.db.prepare('SELECT accountId,orderId,asset,deltaRaw,nativeAfterRaw FROM ledger ORDER BY id').all() as {accountId:string;orderId:string|null;asset:string;deltaRaw:string;nativeAfterRaw:string}[];
  const byAccount=new Map(accounts.map(a=>[a.id,a])),byOrder=new Map(orders.map(o=>[o.id,o])),byPosition=new Map(positions.map(p=>[p.id,p]));
  const ledger=this.store.db.prepare("SELECT accountId,SUM(CASE WHEN asset='native' THEN 1 ELSE 0 END) count FROM ledger GROUP BY accountId").all();
  const integer=(n:string)=>{if(!/^\d+$/.test(n))throw Error('数量字段无效');return BigInt(n);},moneyEqual=(a:number,b:number)=>usdInt(a)===usdInt(b),addMoney=(ns:number[])=>usdFloat(ns.reduce((n,v)=>n+usdInt(v),0n));
  const checked=(id:string,fn:()=>void)=>{try{fn();}catch(e){errors.push(id+':'+(e instanceof Error?e.message:'账本字段无效'));}};
  for(const a of accounts)checked(a.id,()=>{
   const balance=integer(a.nativeBalanceRaw??'0'),reserved=integer(a.reservedNativeRaw),pending=orders.filter(o=>o.accountId===a.id&&ACTIVE.has(o.status));if(reserved>balance)throw Error('余额或冻结异常');if(pending.reduce((n,o)=>n+integer(o.reservedNativeRaw),0n)!==reserved)throw Error('订单冻结金额与账户不一致');
   const nativeRows=rows.filter(r=>r.accountId===a.id&&r.asset==='native'),deposits=nativeRows.filter(r=>r.orderId===null),depositFx=this.store.meta<number>('depositFx:'+a.id);let running=0n;for(const row of nativeRows){running+=BigInt(row.deltaRaw);if(running<0n||running!==integer(row.nativeAfterRaw))throw Error('现金流水余额不平');}if(running!==balance)throw Error('现金账本不平');if(a.nativeBalanceRaw!==null){if(deposits.length!==1||!depositFx||BigInt(deposits[0].deltaRaw)!==usdNative(a.initialCapitalUsd,depositFx))throw Error('初始虚拟本金与入账汇率不一致');if(!a.nativeUsd||!moneyEqual(a.cashUsd,nativeUsd(balance,a.nativeUsd)))throw Error('美元现金与原生币余额不一致');}else if(deposits.length)throw Error('未注资账户出现本金流水');
   const ownFills=fills.filter(f=>f.accountId===a.id),failures=rows.filter(r=>r.accountId===a.id&&r.asset==='native'&&r.orderId&&byOrder.get(r.orderId)?.status==='failed');
   const failedFees=failures.map(r=>{const q=byOrder.get(r.orderId!)?.fillQuote;if(!q||BigInt(r.deltaRaw)>0n)throw Error('失败费用没有报价依据');return nativeUsd(-BigInt(r.deltaRaw),q.nativeUsd);});
   if(!moneyEqual(a.realizedUsd,addMoney([...ownFills.filter(f=>f.side==='sell').map(f=>f.netUsd),...failedFees.map(v=>-v)])))throw Error('已实现损益与成交、失败费用不一致');
   if(!moneyEqual(a.feesUsd,addMoney([...ownFills.map(f=>f.fees.gasUsd+f.fees.approvalUsd+f.fees.protocolUsd+f.fees.taxUsd+f.fees.conversionUsd),...failedFees])))throw Error('累计费用与成交、失败费用不一致');
   const tokens=new Set([...rows.filter(r=>r.accountId===a.id&&r.asset!=='native').map(r=>r.asset),...positions.filter(p=>p.accountId===a.id).map(p=>p.token)]);
   for(const token of tokens){const ledgerQuantity=rows.filter(r=>r.accountId===a.id&&r.asset===token).reduce((n,r)=>n+BigInt(r.deltaRaw),0n),quantity=positions.filter(p=>p.accountId===a.id&&p.token===token).reduce((n,p)=>n+integer(p.remainingRaw),0n);if(ledgerQuantity!==quantity)throw Error('代币流水与批次余仓不一致');}
  });
  for(const p of positions)checked(p.id,()=>{
   if(!byAccount.has(p.accountId)||byAccount.get(p.accountId)!.chain!==p.chain)throw Error('批次账户归属无效');const original=integer(p.originalRaw),remaining=integer(p.remainingRaw);if(remaining>original||original===0n)throw Error('余仓异常');
   const own=fills.filter(f=>f.positionId===p.id),buys=own.filter(f=>f.side==='buy'),sells=own.filter(f=>f.side==='sell');if(buys.length!==1||integer(buys[0].tokenRaw)!==original||original-sells.reduce((n,f)=>n+integer(f.tokenRaw),0n)!==remaining)throw Error('原仓或余仓与成交不一致');
   if(!moneyEqual(p.costUsd,buys[0].usd)||!moneyEqual(p.remainingCostUsd,addMoney([p.costUsd,...sells.map(f=>-f.costBasisUsd)]))||!moneyEqual(p.cashBackUsd,addMoney(sells.map(f=>f.usd)))||!moneyEqual(p.netRealizedUsd,addMoney(sells.map(f=>f.netUsd))))throw Error('批次成本或损益对账失败');
   let qty=original,cost=p.costUsd;for(const f of sells){const sold=integer(f.tokenRaw);if(sold>qty)throw Error('累计卖出超过原仓');const basis=sold===qty?cost:allocateUsd(cost,sold,qty);if(!moneyEqual(f.costBasisUsd,basis)||!moneyEqual(f.netUsd,addMoney([f.usd,-basis])))throw Error('卖出成本分配或净收益不一致');qty-=sold;cost=addMoney([cost,-basis]);}
   if((remaining===0n)!==(p.closedAt!==null))throw Error('批次关闭状态与余仓不一致');
   const pending=orders.filter(o=>o.positionId===p.id&&o.side==='sell'&&ACTIVE.has(o.status));if(pending.length>1||((p.pendingOrderId??null)!==(pending[0]?.id??null)))throw Error('批次待卖订单指针不一致');
   const expected=this.reconstructedProgress(p,own,byOrder);for(let i=0;i<p.rules.targets.length;i++){if(this.targetProgress(p,i)!==integer(expected[i]??'0'))throw Error('止盈数量进度与成交不一致');if(p.doneTargets.includes(i)!==(this.targetProgress(p,i)>=this.targetQuantity(p,i)))throw Error('止盈完成标记与数量不一致');}
  });
  for(const o of orders)checked(o.id,()=>{
   if(!byAccount.has(o.accountId)||byAccount.get(o.accountId)!.chain!==o.chain)throw Error('订单账户归属无效');const own=fills.filter(f=>f.orderId===o.id),complete=o.status==='filled'||o.status==='partial';if(own.length!==(complete?1:0))throw Error('订单状态与成交数量不一致');if(!ACTIVE.has(o.status)&&integer(o.reservedNativeRaw)!==0n)throw Error('结束订单仍有冻结资金');if(o.side==='sell'&&integer(o.reservedNativeRaw)!==0n)throw Error('卖单冻结了买入本金');const orderRows=rows.filter(r=>r.orderId===o.id);if((ACTIVE.has(o.status)||o.status==='cancelled')&&orderRows.length)throw Error('未成交或取消订单出现资金流水');if(o.status==='failed'&&(orderRows.length>1||orderRows.some(r=>r.asset!=='native'||BigInt(r.deltaRaw)>0n)))throw Error('失败订单出现非法资金或代币流水');
   if(o.status==='failed'&&orderRows.length){const q=o.fillQuote;if(!q||BigInt(orderRows[0].deltaRaw)!==-usdNative(outsideFees(q),q.nativeUsd,true))throw Error('失败费用与报价不一致');}
   if(complete){const f=own[0],q=o.fillQuote;if(!q||f.accountId!==o.accountId||f.chain!==o.chain||f.token!==o.token||f.side!==o.side||f.positionId!==o.positionId||f.block!==q.block||f.at!==o.filledAt||f.priceUsd!==q.priceUsd||hash(f.fees)!==hash(q.fees)||integer(f.tokenRaw)!==integer(o.side==='buy'?q.outputRaw:q.spentInputRaw)||integer(f.nativeRaw)!==integer(o.side==='buy'?q.spentInputRaw:q.outputRaw)||!byPosition.has(f.positionId))throw Error('成交与订单报价不一致');
    const cash=rows.filter(r=>r.orderId===o.id&&r.asset==='native'),tokens=rows.filter(r=>r.orderId===o.id&&r.asset===o.token),extra=usdNative(outsideFees(q),q.nativeUsd,true),delta=o.side==='buy'?-(integer(q.spentInputRaw)+extra):integer(q.outputRaw)-extra;
    if(cash.length!==1||BigInt(cash[0].deltaRaw)!==delta||tokens.length!==1||BigInt(tokens[0].deltaRaw)!==(o.side==='buy'?integer(f.tokenRaw):-integer(f.tokenRaw)))throw Error('成交对应的现金或代币流水不一致');if(o.side==='buy'&&integer(byPosition.get(f.positionId)!.costNativeRaw)!==-delta)throw Error('原生币买入成本不一致');
    const expectedUsd=o.side==='buy'?nativeUsd(-delta,q.nativeUsd):usdFloat(usdInt(nativeUsd(q.outputRaw,q.nativeUsd)-outsideFees(q)));if(!moneyEqual(f.usd,expectedUsd))throw Error('成交美元净现金与原生币报价不一致');
   }
  });
  for(const row of rows)if(!byAccount.has(row.accountId)||(row.orderId&&!byOrder.has(row.orderId)))errors.push('流水账户或订单不存在');for(const f of fills)if(!byOrder.has(f.orderId)||!byPosition.has(f.positionId))errors.push(f.id+':成交订单或批次不存在');
  return {passed:errors.length===0,errors,ledger};
 }
}
