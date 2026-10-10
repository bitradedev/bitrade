import {identifier,fail,json} from './database.mjs';
import {address} from './auth.mjs';
const UNIT=10n**18n,active=new Set(['preparing','queued','quoting']);
const nativeUsd=(v,fx)=>Number(BigInt(v))/1e18*fx;
const feeRaw=q=>BigInt(Math.ceil((q.fees.gasUsd+q.fees.approvalUsd)/q.nativeUsd*1e18));
export class PaperDesk{
 constructor(store,gateway,{buyGuard}={}){this.store=store;this.gateway=gateway;this.buyGuard=buyGuard;this.busy=false;this.stopped=false;this.revision=0;this.locks=new Map();for(const o of this.orders().filter(x=>active.has(x.status))){o.status='cancelled';o.error='服务重启，未假定离线期间成交';this.store.put('paper-orders',o);}}
 orders(id){return this.store.all('paper-orders').filter(o=>!id||o.agentId===id);}
 fills(id){return this.store.all('paper-fills').filter(o=>!id||o.agentId===id);}
 lots(id){return this.store.all('paper-lots').filter(o=>o.agentId===id&&BigInt(o.remainingRaw)>0n).sort((a,b)=>a.at-b.at);}
 fx(){const h=this.gateway.statuses().find(x=>x.chain==='bsc');if(!h?.connected||Date.now()-h.headAt>15000)return null;const m=this.gateway.markets().filter(x=>x.chain==='bsc'&&x.quality==='verified'&&Date.now()-x.updatedAt<=15000&&Number.isFinite(x.nativeUsd)&&x.nativeUsd>0).sort((a,b)=>b.updatedAt-a.updatedAt)[0];return m?.nativeUsd??null;}
 account(id){let a=this.store.get('paper-accounts',id);if(!a){a={id,initialUsd:1000,nativeRaw:null,realizedNativeRaw:'0',realizedUsd:0,feesUsd:0,createdAt:Date.now()};this.store.put('paper-accounts',a);}else if(a.initialUsd<1000){a=this.store.transaction(()=>{const current=this.store.get('paper-accounts',id);if(current.initialUsd>=1000)return current;const deltaUsd=1000-current.initialUsd;if(current.nativeRaw!==null){if(!Number.isFinite(current.seedFx)||current.seedFx<=0)throw fail('旧模拟本金的换算依据缺失，无法补足本金');const delta=BigInt(Math.floor(deltaUsd/current.seedFx*1e18));current.nativeRaw=String(BigInt(current.nativeRaw)+delta);this.ledger(id,delta,'virtual-capital-adjustment',null,{usdDelta:deltaUsd});}current.initialUsd=1000;this.store.put('paper-accounts',current);return current;});}return a;}
 ledger(id,delta,kind,orderId=null,extra={}){this.store.put('paper-ledger',{id:identifier(),agentId:id,deltaRaw:String(delta),kind,orderId,at:Date.now(),...extra});}
 seed(id,fx){if(!Number.isFinite(fx)||fx<=0)throw fail('BNB美元参考价无效');return this.store.transaction(()=>{const a=this.account(id);if(a.nativeRaw===null){a.nativeRaw=String(BigInt(Math.floor(a.initialUsd/fx*1e18)));a.seedFx=fx;this.store.put('paper-accounts',a);this.ledger(id,a.nativeRaw,'initial-virtual-capital');}return a;});}
 head(){const h=this.gateway.statuses().find(c=>c.chain==='bsc');if(!h?.connected||Date.now()-h.headAt>15000||!h.head)throw fail('BSC行情已过期，暂缓模拟交易',503);return h;}
 async quote(agent,side,token,amount,block){let q;try{q=await this.gateway.quote({chain:'bsc',token,side,recipient:agent.address,block,...(side==='buy'?{nativeAmountRaw:amount}:{tokenAmountRaw:amount})});}catch(e){throw fail(e.message,503);}
  if(q.chain!=='bsc'||q.token.toLowerCase()!==token||q.side!==side||q.block!==block||q.inputRaw!==amount||BigInt(q.outputRaw)<=0n||BigInt(q.spentInputRaw)<=0n||BigInt(q.spentInputRaw)>BigInt(amount)||BigInt(q.refundRaw)!==BigInt(amount)-BigInt(q.spentInputRaw)||!q.fees?.includedInOutput||q.quality==='unavailable'||q.fees.quality==='unavailable'||![q.nativeUsd,q.priceUsd].every(x=>Number.isFinite(x)&&x>0)||[q.fees.gasUsd,q.fees.approvalUsd,q.fees.protocolUsd,q.fees.taxUsd,q.fees.conversionUsd].some(x=>!Number.isFinite(x)||x<0)||!Number.isInteger(q.tokenDecimals)||q.tokenDecimals<0||q.tokenDecimals>36||Date.now()-q.at<0||Date.now()-q.at>5000)throw fail('报价数量、费用或时间未核实',503);return q;
 }
 current(agent){const a=agent?this.store.get('agents',agent.id):null;if(this.stopped||!a||a.closedAt||a.paused||a.mode!=='paper')throw fail('Agent已关闭、暂停或交易模式已变化',409);return a;}
 policyCheck(agent,side,token,q){const p=this.current(agent).policy;if(p?.mode!=='limited')return;const spent=this.fills(agent.id).filter(f=>f.side==='buy').reduce((n,f)=>n+BigInt(f.nativeRaw),0n),cost=BigInt(q.spentInputRaw)+feeRaw(q);if(p.expiresAt<=Date.now()||side!=='buy'||!p.tokens.includes(token)||spent+cost>BigInt(p.budgetWei)||feeRaw(q)>BigInt(p.maxGasWei))throw fail('模拟交易超过Owner签名授权的代币、预算或Gas限制',403);}
 async submit(agent,input){if(this.locks.has(agent.id))throw fail('该Agent正在准备另一笔交易',409);const task=this.prepare(agent,input);this.locks.set(agent.id,task);try{return await task;}finally{this.locks.delete(agent.id);}}
 async prepare(agent,{id,token,side,amount,minOutput='0',reason='Agent提交模拟交易'}){
  this.current(agent);if(this.orders(agent.id).some(o=>active.has(o.status)))throw fail('请先核对该Agent的待处理订单',409);token=address(token);
  if(side==='buy')await this.buyGuard?.(agent,token,{inputRaw:amount,nativeUsd:this.fx(),refresh:true,marketPrice:this.gateway.getMarket('bsc',token)?.priceUsd});
  const revision=this.revision,head=this.head(),q=await this.quote(agent,side,token,amount,head.head);this.current(agent);if(revision!==this.revision)throw fail('行情代次改变，重新报价',409);
  const a=this.seed(agent.id,q.nativeUsd),cost=BigInt(q.spentInputRaw)+feeRaw(q);
  this.policyCheck(agent,side,token,q);
  if(side==='buy'){
   if(cost>BigInt(a.nativeRaw))throw fail('虚拟余额不足（含费用）');
   const reverse=await this.quote(agent,'sell',token,q.outputRaw,q.block);if(reverse.spentInputRaw!==reverse.inputRaw)throw fail('整仓反向报价尚未核实');
  }else if(this.lots(agent.id).filter(p=>p.token===token).reduce((n,p)=>n+BigInt(p.remainingRaw),0n)<BigInt(amount))throw fail('卖出数量超过已知成本的模拟持仓');
  this.current(agent);if(revision!==this.revision||Date.now()-q.at>5000)throw fail('准备期间行情已过期，重新报价',409);
  this.policyCheck(agent,side,token,q);
  const o={id,agentId:agent.id,mode:'paper',chainId:56,token,side,inputRaw:amount,minOutput,slippageBps:100,status:'queued',createdAt:Date.now(),dueAt:Date.now()+500,afterBlock:q.block,reference:q,reason,error:'',hash:null};this.store.put('paper-orders',o);return o;
 }
 cancel(id,message='用户取消未完成模拟订单'){const o=this.store.get('paper-orders',id);if(!o||!active.has(o.status))throw fail('该订单已不能取消',409);o.status='cancelled';o.error=message;this.store.put('paper-orders',o);return o;}
 pause(id){for(const o of this.orders(id).filter(o=>active.has(o.status)))this.cancel(o.id,'Agent暂停，未完成模拟订单取消');}
 gap(){this.revision++;for(const o of this.orders().filter(o=>active.has(o.status)))this.cancel(o.id,'行情中断或重组，旧报价失效');}
 async tick(){if(this.busy||this.stopped)return;this.busy=true;try{
  for(const o of this.orders().filter(o=>o.status==='queued')){let q;
   try{const h=this.head();if(Date.now()<o.dueAt||h.head<=o.afterBlock||h.headAt<o.dueAt)continue;const agent=this.store.get('agents',o.agentId);this.current(agent);const rev=this.revision;o.status='quoting';this.store.put('paper-orders',o);
    q=await this.quote(agent,o.side,o.token,o.inputRaw,h.head);
    if(o.side==='buy')await this.buyGuard?.(agent,o.token,{inputRaw:q.spentInputRaw,nativeUsd:q.nativeUsd,marketPrice:q.priceUsd,refresh:false});
    this.current(agent);const latest=this.store.get('paper-orders',o.id);if(latest.status!=='quoting'||rev!==this.revision)continue;
    if(Date.now()-q.at>5000||!this.head().connected)throw fail('撮合报价已过期');
    if(BigInt(q.outputRaw)<BigInt(o.reference.outputRaw)*99n/100n||BigInt(q.outputRaw)<BigInt(o.minOutput))throw fail('新区块报价超出1%滑点或最低输出限制');
    this.policyCheck(agent,o.side,o.token,q);
    this.fill(o,q);
   }catch(e){const latest=this.store.get('paper-orders',o.id);if(latest&&active.has(latest.status)){latest.status='failed';latest.error=e.message;this.store.put('paper-orders',latest);}}
  }
 }finally{this.busy=false;}}
 fill(o,q){return this.store.transaction(()=>{
  const current=this.store.get('paper-orders',o.id);if(current.status!=='quoting')throw fail('订单状态已改变');const a=this.account(o.agentId),outside=feeRaw(q);let basis=0n,basisUsd=0,net=0n,netUsd=0;
  if(o.side==='buy'){const cost=BigInt(q.spentInputRaw)+outside;if(cost>BigInt(a.nativeRaw))throw fail('撮合时虚拟余额不足');a.nativeRaw=String(BigInt(a.nativeRaw)-cost);this.ledger(o.agentId,-cost,'buy',o.id);
   this.store.put('paper-lots',{id:identifier(),agentId:o.agentId,token:o.token,decimals:q.tokenDecimals,remainingRaw:q.outputRaw,nativeCostRaw:String(cost),usdCost:nativeUsd(cost,q.nativeUsd),at:Date.now(),orderId:o.id});
  }else{
   let wanted=BigInt(q.spentInputRaw);const lots=this.lots(o.agentId).filter(p=>p.token===o.token);if(lots.reduce((n,p)=>n+BigInt(p.remainingRaw),0n)<wanted)throw fail('FIFO余仓已变化');
   for(const p of lots){if(wanted===0n)break;const old=BigInt(p.remainingRaw),take=wanted<old?wanted:old,cost=take===old?BigInt(p.nativeCostRaw):BigInt(p.nativeCostRaw)*take/old,costUsd=take===old?p.usdCost:p.usdCost*Number(take)/Number(old);basis+=cost;basisUsd+=costUsd;p.remainingRaw=String(old-take);p.nativeCostRaw=String(BigInt(p.nativeCostRaw)-cost);p.usdCost-=costUsd;wanted-=take;this.store.put('paper-lots',p);}
   const proceeds=BigInt(q.outputRaw)-outside;if(BigInt(a.nativeRaw)+proceeds<0n)throw fail('虚拟余额不足以支付退出费用');a.nativeRaw=String(BigInt(a.nativeRaw)+proceeds);net=proceeds-basis;netUsd=nativeUsd(proceeds,q.nativeUsd)-basisUsd;a.realizedNativeRaw=String(BigInt(a.realizedNativeRaw)+net);a.realizedUsd+=netUsd;this.ledger(o.agentId,proceeds,'sell',o.id);
  }
  a.feesUsd+=q.fees.gasUsd+q.fees.approvalUsd+q.fees.protocolUsd+q.fees.taxUsd+q.fees.conversionUsd;this.store.put('paper-accounts',a);
  const f={id:identifier(),orderId:o.id,agentId:o.agentId,mode:'paper',chainId:56,token:o.token,side:o.side,tokenRaw:o.side==='buy'?q.outputRaw:q.spentInputRaw,nativeRaw:o.side==='buy'?String(BigInt(q.spentInputRaw)+outside):String(BigInt(q.outputRaw)-outside),usd:o.side==='buy'?nativeUsd(q.spentInputRaw,q.nativeUsd)+q.fees.gasUsd+q.fees.approvalUsd:nativeUsd(q.outputRaw,q.nativeUsd)-q.fees.gasUsd-q.fees.approvalUsd,costBasisRaw:o.side==='sell'?String(basis):null,costBasisUsd:o.side==='sell'?basisUsd:null,netRaw:o.side==='sell'?String(net):null,netUsd:o.side==='sell'?netUsd:null,at:Date.now(),block:q.block,quoteId:q.id,quality:q.quality,fees:q.fees,hash:null};this.store.put('paper-fills',f);
  this.store.put('paper-orders',{...current,status:q.spentInputRaw===q.inputRaw?'filled':'partial',filledAt:Date.now(),quote:q,fillId:f.id});return f;
 });}
 view(id){const a=this.account(id),fx=this.fx(),lots=this.lots(id);return {...a,balanceWei:a.nativeRaw,balanceUsd:a.nativeRaw===null?a.initialUsd:fx?nativeUsd(a.nativeRaw,fx):null,realizedBnb:Number(BigInt(a.realizedNativeRaw))/1e18,positions:lots.map(p=>{const m=this.gateway.getMarket('bsc',p.token);return {...p,symbol:m?.symbol??p.token.slice(0,10),estimatedValueUsd:m?.quality==='verified'&&Date.now()-m.updatedAt<=5000?Number(BigInt(p.remainingRaw))/10**p.decimals*m.priceUsd:null};}),pending:this.orders(id).filter(o=>active.has(o.status)).length};}
 check(id){const a=this.account(id);if(a.nativeRaw===null)return true;return this.store.all('paper-ledger').filter(l=>l.agentId===id).reduce((n,l)=>n+BigInt(l.deltaRaw),0n)===BigInt(a.nativeRaw);}
 async stop(){this.stopped=true;this.gap();await Promise.allSettled([...this.locks.values()]);while(this.busy)await new Promise(r=>setTimeout(r,20));}
}
