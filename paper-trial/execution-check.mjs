import {eligibleMarket,INITIAL_CAPITAL_USD,MAX_ORDER_USD,RULES} from './policy.mjs';
export const CHECK_ACCOUNT={id:'trial-robinhood-check',chain:'robinhood',name:'模拟运行验证 · 非盈利策略',family:'check'};
export class ExecutionCheck {
 busy=false;
 constructor(store,broker,gateway){this.store=store;this.broker=broker;this.gateway=gateway;
  broker.ensureAccount(CHECK_ACCOUNT.id,CHECK_ACCOUNT.name,'robinhood','research');
  const a=broker.account(CHECK_ACCOUNT.id);if(a.initialCapitalUsd!==INITIAL_CAPITAL_USD&&a.nativeBalanceRaw===null&&!broker.orders().some(o=>o.accountId===a.id)){
   for(const key of ['initialCapitalUsd','cashUsd','equityUsd','conservativeEquityUsd','dayStartEquityUsd'])a[key]=INITIAL_CAPITAL_USD;store.put('accounts',a);
  }
  this.record=store.meta('executionCheck')??{status:'idle',summary:'尚未运行：使用独立200U虚拟账本验证买入、自动卖出与扣费，不计入盈利策略对照。',attempts:[]};
  if(this.record.status==='quoting'){this.record.status='interrupted';this.record.summary='上次报价被重启中断，未假定成交，可重新验证';this.save();}
 }
 save(){this.store.setMeta('executionCheck',this.record);}
 state(){const a=this.broker.account(CHECK_ACCOUNT.id),orders=this.broker.orders().filter(o=>o.accountId===a.id),position=this.broker.positions().find(p=>p.id===this.record.positionId)||this.broker.positions().find(p=>p.accountId===a.id&&!p.closedAt),buy=orders.find(o=>o.id===this.record.orderId),fills=this.broker.fills().filter(f=>f.accountId===a.id&&(!position||f.positionId===position.id));
  if(buy?.positionId&&!this.record.positionId){this.record.positionId=buy.positionId;return this.state();}
  if(position?.closedAt){this.record.status='completed';this.record.summary='真实报价的模拟买入、自动卖出已完成；现金与代币账本'+(this.broker.checks().passed?'对账通过':'对账异常');this.save();}
  else if(position){this.record.status='holding';this.record.summary='已模拟买入，按30秒最长持有规则自动卖出；退出仍使用新区块可卖报价';}
  else if(buy&&['failed','cancelled'].includes(buy.status)){this.record.status='failed';this.record.summary='本次未成交：'+buy.error;this.save();}
  return {...this.record,account:a,orders,position:position??null,fills,busy:this.busy,ledgerPassed:this.broker.checks().passed};
 }
 async run(){
  const current=this.state();if(this.busy||current.position&&!current.position.closedAt||current.orders.some(o=>['queued','quoting','waiting'].includes(o.status)))throw Error('运行验证正在处理，请等待本笔退出');
  if(this.broker.account(CHECK_ACCOUNT.id).paused||this.broker.accounts().filter(a=>a.id.startsWith('trial-robinhood-')&&a.id!==CHECK_ACCOUNT.id).every(a=>a.paused))throw Error('Robinhood新仓已暂停，恢复后再验证');
  this.busy=true;this.record={status:'quoting',startedAt:Date.now(),summary:'正在读取Pons V2候选的10U买入、整仓反向报价；未通过检查不会记成交',budgetUsd:10,attempts:[]};this.save();
  try{
   const candidates=this.gateway.markets().filter(m=>m.chain==='robinhood'&&eligibleMarket(m)&&m.platform==='pons-v2'&&['pons-v2','v4'].includes(m.metadata?.route)&&m.decimals!==null&&m.nativeUsd>0).sort((a,b)=>Number(b.metadata?.route==='v4')-Number(a.metadata?.route==='v4')||Number(b.quality==='verified')-Number(a.quality==='verified')||b.updatedAt-a.updatedAt).slice(0,8);
   if(!candidates.length)throw Error('尚无可验证的Pons V2内盘或毕业池候选，等待真实路线及汇率');
   for(const m of candidates){
    if(this.broker.stopped)throw Error('模拟已停止');
    try{
     const head=this.broker.fresh('robinhood'),q=await this.broker.quoteBudget(CHECK_ACCOUNT.id,m.address,10,head.head);
     if(q.quality!=='verified'||!['pons-v2','v4'].includes(q.venue)||q.priceImpactPct>2)throw Error('需要已核实的V2或毕业池报价且价格冲击≤2%');
     const reverse=await this.broker.getQuote(CHECK_ACCOUNT.id,{chain:'robinhood',token:m.address,side:'sell',recipient:this.broker.recipient(CHECK_ACCOUNT.id),tokenAmountRaw:q.outputRaw,block:q.block});
     const order=await this.broker.submit({clientId:'check:'+crypto.randomUUID(),accountId:CHECK_ACCOUNT.id,token:m.address,side:'buy',amountUsd:Number(BigInt(q.inputRaw))/1e18*q.nativeUsd,slippagePct:3,
      rules:{...structuredClone(RULES),maxHoldMs:30000},source:'execution-check',reason:'模拟运行验证：独立账本10U买入，30秒后按新鲜可卖报价退出；不作为盈利信号'}, {reference:q,reverse});
     this.record={...this.record,status:'queued',token:m.address,symbol:m.symbol,orderId:order.id,summary:'买卖报价与费用检查通过，已提交10U虚拟买单，等待500毫秒和后续区块'};
     this.store.audit('execution-check',this.record.summary,{chain:'robinhood',account:CHECK_ACCOUNT.id,token:m.address,orderId:order.id,entryQuoteId:q.id,reverseQuoteId:reverse.id,maxOrderUsd:MAX_ORDER_USD});this.save();return this.state();
    }catch(e){this.record.attempts.push({at:Date.now(),token:m.address,symbol:m.symbol,reason:e.message});this.record.summary='本候选未通过：'+e.message+'；继续检查下一候选';this.save();}
   }
   throw Error('当前候选均未通过具体数量的买卖报价，详情已记录');
  }catch(e){this.record.status='failed';this.record.summary=e.message;this.save();return this.state();}
  finally{this.busy=false;}
 }
}
