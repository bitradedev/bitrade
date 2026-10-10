import {viem} from './dependencies.mjs';
import {fail,identifier,json} from './database-core.mjs';
import {v2Abi,v3Abi,erc20Abi,WBNB,ROUTER_V2,ROUTER_V3} from './bsc-rpc.mjs';

const pending=new Set(['preparing','signed','submitted']);
export const executionError=e=>e.status?e.message:'BSC网络请求或合约模拟未完成；请核对原订单，详情见服务端日志';
const withdrawAbi=viem.parseAbi(['event Withdrawal(address indexed src,uint256 wad)','event Deposit(address indexed dst,uint256 wad)']);
export function swapIntent(tx,agent){
 try{
  const to=tx.to.toLowerCase();
  if(to===ROUTER_V2){const d=viem.decodeFunctionData({abi:v2Abi,data:tx.data});
   if(d.functionName.startsWith('swapExactETHForTokens')&&d.args[2].toLowerCase()===agent.address&&d.args[1].length===2&&d.args[1][0].toLowerCase()===WBNB)return {side:'buy',token:d.args[1][1].toLowerCase(),nativeIn:String(tx.value),venue:'pancake-v2'};
   if(d.functionName.startsWith('swapExactTokensForETH')&&d.args[3].toLowerCase()===agent.address&&d.args[2].length===2&&d.args[2][1].toLowerCase()===WBNB&&BigInt(tx.value)===0n)return {side:'sell',token:d.args[2][0].toLowerCase(),venue:'pancake-v2'};
  }
  if(to===ROUTER_V3){let calls=[viem.decodeFunctionData({abi:v3Abi,data:tx.data})];if(calls[0].functionName==='multicall')calls=calls[0].args[0].map(data=>viem.decodeFunctionData({abi:v3Abi,data}));
   const swap=calls[0];if(swap.functionName!=='exactInputSingle'||calls.length>2)return null;const p=swap.args[0];
   if(p.tokenIn.toLowerCase()===WBNB&&p.recipient.toLowerCase()===agent.address&&calls.length===2&&calls[1].functionName==='refundETH'&&BigInt(tx.value)===p.amountIn)return {side:'buy',token:p.tokenOut.toLowerCase(),venue:'pancake-v3'};
   if(p.tokenOut.toLowerCase()===WBNB&&p.recipient.toLowerCase()===ROUTER_V3&&calls.length===2&&calls[1].functionName==='unwrapWETH9'&&calls[1].args[1].toLowerCase()===agent.address&&BigInt(tx.value)===0n)return {side:'sell',token:p.tokenIn.toLowerCase(),venue:'pancake-v3'};
  }
 }catch{}return null;
}

// Only confirmed, decoded router swaps enter the P&L book. Deposits, approvals,
// transfers and unknown routes remain activity, with no invented cost basis.
export function recordReceipt(store,agent,order,receipt,at){
 if(store.get('live-accounted',order.id))return;
 store.transaction(()=>{
  const gas=receipt.gasUsed*receipt.effectiveGasPrice,info=swapIntent(order.transaction,agent),row={id:order.id,agentId:agent.id,mode:'live',chainId:56,hash:order.hash,at,block:Number(receipt.blockNumber),status:receipt.status,gasRaw:String(gas),kind:order.kind??'contract',side:null,token:null,tokenRaw:null,nativeRaw:null,netRaw:null,costBasisRaw:null};
  const movements=new Map();if(receipt.status==='success')for(const log of receipt.logs)try{const e=viem.decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics});if(e.eventName!=='Transfer')continue;let delta=0n;if(e.args.to.toLowerCase()===agent.address)delta+=e.args.value;if(e.args.from.toLowerCase()===agent.address)delta-=e.args.value;const token=log.address.toLowerCase();if(delta)movements.set(token,(movements.get(token)??0n)+delta);}catch{}
  if(receipt.status==='success'&&info){let tokenChange=0n,native=info.nativeIn?BigInt(info.nativeIn):null,wrapped=0n;
   for(const log of receipt.logs){try{if(log.address.toLowerCase()===info.token){const e=viem.decodeEventLog({abi:erc20Abi,data:log.data,topics:log.topics});if(e.eventName==='Transfer'){if(e.args.to.toLowerCase()===agent.address)tokenChange+=e.args.value;if(e.args.from.toLowerCase()===agent.address)tokenChange-=e.args.value;}}
    if(log.address.toLowerCase()===WBNB){const e=viem.decodeEventLog({abi:withdrawAbi,data:log.data,topics:log.topics});if(info.side==='sell'&&e.eventName==='Withdrawal'&&e.args.src.toLowerCase()===order.transaction.to.toLowerCase())wrapped+=e.args.wad;if(info.side==='buy'&&info.venue==='pancake-v3'&&e.eventName==='Deposit'&&e.args.dst.toLowerCase()===order.transaction.to.toLowerCase())wrapped+=e.args.wad;}
   }catch{}}
   if(info.side==='sell'||info.venue==='pancake-v3')native=wrapped>0n?wrapped:null;
   if(native!==null&&native>0n&&(info.side==='buy'?tokenChange>0n:tokenChange<0n)){
    row.kind='swap';row.side=info.side;row.token=info.token;row.tokenRaw=String(tokenChange<0n?-tokenChange:tokenChange);row.nativeRaw=String(native);row.venue=info.venue;
    if(info.side==='buy')store.put('live-lots',{id:identifier(),agentId:agent.id,token:info.token,remainingRaw:row.tokenRaw,nativeCostRaw:String(native+gas),at,orderId:order.id});
    else {let wanted=-tokenChange,basis=0n,unknown=false;const lots=store.all('live-lots').filter(p=>p.agentId===agent.id&&p.token===info.token&&BigInt(p.remainingRaw)>0n).sort((a,b)=>a.at-b.at);
     for(const p of lots){if(!wanted)break;const old=BigInt(p.remainingRaw),take=old<wanted?old:wanted;let cost=0n;if(p.nativeCostRaw===null)unknown=true;else{cost=take===old?BigInt(p.nativeCostRaw):BigInt(p.nativeCostRaw)*take/old;p.nativeCostRaw=String(BigInt(p.nativeCostRaw)-cost);}p.remainingRaw=String(old-take);store.put('live-lots',p);wanted-=take;basis+=cost;}
     if(wanted===0n&&!unknown){row.costBasisRaw=String(basis);row.netRaw=String(native-gas-basis);}else row.unknownCost=true;
    }
   }else row.accountingNote='链上回执未提供完整可核对的兑换资金流';
  }
  // Generic transfers also change inventory. Otherwise a token sent out and
  // later returned could incorrectly inherit a previous buy's cost basis.
  for(const [token,delta]of movements){if(row.kind==='swap'&&row.token===token)continue;if(delta>0n)store.put('live-lots',{id:identifier(),agentId:agent.id,token,remainingRaw:String(delta),nativeCostRaw:null,at,orderId:order.id,unknownCost:true});
   else if(delta<0n){let wanted=-delta;for(const p of store.all('live-lots').filter(p=>p.agentId===agent.id&&p.token===token&&BigInt(p.remainingRaw)>0n).sort((a,b)=>a.at-b.at)){if(!wanted)break;const old=BigInt(p.remainingRaw),take=old<wanted?old:wanted;if(p.nativeCostRaw!==null)p.nativeCostRaw=String(BigInt(p.nativeCostRaw)-(take===old?BigInt(p.nativeCostRaw):BigInt(p.nativeCostRaw)*take/old));p.remainingRaw=String(old-take);wanted-=take;store.put('live-lots',p);}}
  }
  store.put('live-activity',row);store.put('live-accounted',{id:order.id,at});
 });
}

export class LiveDesk{
 constructor(store,vault,rpc,{enabled=false,confirmations=3}={}){this.store=store;this.vault=vault;this.rpc=rpc;Object.defineProperty(this,'enabled',{value:enabled===true,writable:false});this.confirmations=confirmations;this.locks=new Map();this.busy=false;this.stopped=false;
  for(const o of this.orders().filter(o=>o.status==='preparing'))this.store.put('live-orders',{...o,status:'failed',error:'服务在签名前重启；没有生成或广播交易'});
 }
 guard(){if(!this.enabled)throw fail('实盘功能尚未开启，禁止签名或广播真钱交易',423);if(this.stopped)throw fail('执行服务正在停止',503);}
 orders(id){return this.store.all('live-orders').filter(o=>!id||o.agentId===id);}
 check(agent,ownerWithdrawal=false){this.guard();const a=this.store.get('agents',agent.id);if(!a||a.closedAt||a.ownerId!==agent.ownerId||a.mode!=='live'||!ownerWithdrawal&&a.paused)throw fail('实盘Agent身份、模式或暂停状态不允许交易',409);return a;}
 async submit(agent,id,transaction,ownerWithdrawal=false){this.guard();if(this.locks.has(agent.id)||this.orders(agent.id).some(o=>pending.has(o.status)))throw fail('该Agent有待核对的实盘交易',409);
  const work=this.prepare(agent,id,transaction,ownerWithdrawal);this.locks.set(agent.id,work);try{return await work;}finally{this.locks.delete(agent.id);}
 }
 async prepare(agent,id,transaction,ownerWithdrawal){
  this.check(agent,ownerWithdrawal);let order={id,agentId:agent.id,mode:'live',chainId:56,status:'preparing',kind:transaction.kind??'contract',createdAt:Date.now(),hash:null,error:''};this.store.put('live-orders',order);
  try {const tx=await this.rpc.prepare(agent,transaction);const current=this.check(agent,ownerWithdrawal);
   if(current.policy?.mode==='limited'){
    if(ownerWithdrawal)throw fail('受限Agent须先恢复余额模式才能提款');const p=current.policy,spent=this.orders(agent.id).filter(o=>o.id!==id&&['signed','submitted','confirmed','reverted'].includes(o.status)).reduce((n,o)=>n+BigInt(o.transaction?.value??0)+BigInt(o.transaction?.gas??0)*BigInt(o.transaction?.gasPrice??0),0n);
    if(p.expiresAt<=Date.now()||!p.tokens.includes(transaction.token)||transaction.kind!=='buy'||spent+tx.value+tx.gas*tx.gasPrice>BigInt(p.budgetWei)||tx.gas*tx.gasPrice>BigInt(p.maxGasWei))throw fail('交易超过Owner签名授权的代币、资金或Gas限制',403);
   }
   const account=this.vault.account(current);const serialized=await account.signTransaction(tx);const hash=viem.keccak256(serialized);
   // Persist exact signed bytes BEFORE sending. Retries only send these bytes.
   order={...order,status:'signed',signedAt:Date.now(),hash,transaction:JSON.parse(json(tx)),signed:this.vault.encrypt(serialized,'signed-tx:'+id)};this.store.put('live-orders',order);
   return await this.send(order);
  }catch(e){const latest=this.store.get('live-orders',id);if(latest?.status==='preparing'){latest.status='failed';latest.error=executionError(e);this.store.put('live-orders',latest);}else if(latest){latest.error='广播或核对未完成：'+executionError(e);this.store.put('live-orders',latest);}throw e;}
 }
 async send(order){this.guard();const raw=this.vault.decrypt(order.signed,'signed-tx:'+order.id);if(viem.keccak256(raw)!==order.hash)throw fail('已签名交易校验失败',500);
  const result=await this.rpc.broadcast(raw);if(result.toLowerCase()!==order.hash.toLowerCase())throw fail('广播返回的交易哈希不匹配',502);order.status='submitted';order.submittedAt??=Date.now();order.error='';this.store.put('live-orders',order);return order;
 }
 async reconcile(order){this.guard();if(!['signed','submitted'].includes(order.status))return order;
  const receipt=await this.rpc.receipt(order.hash);
  if(!receipt){if(Date.now()-(order.lastRetryAt??order.signedAt)>30000){order.lastRetryAt=Date.now();this.store.put('live-orders',order);try{await this.send(order);}catch(e){order.error='等待原交易核对：'+executionError(e);this.store.put('live-orders',order);}}return this.store.get('live-orders',order.id);}
  const [latest,canonical]=await Promise.all([this.rpc.client.getBlockNumber(),this.rpc.block(receipt.blockNumber)]);
  if(canonical.hash!==receipt.blockHash||latest-receipt.blockNumber+1n<BigInt(this.confirmations))return order;
  const agent=this.store.get('agents',order.agentId);recordReceipt(this.store,agent,order,receipt,Number(canonical.timestamp)*1000);order.status=receipt.status==='success'?'confirmed':'reverted';order.confirmedAt=Date.now();order.block=Number(receipt.blockNumber);order.gasUsedRaw=String(receipt.gasUsed);order.error=receipt.status==='success'?'':'链上执行失败，Gas已实际消耗';this.store.put('live-orders',order);return order;
 }
 async tick(){if(!this.enabled||this.busy||this.stopped)return;this.busy=true;try{for(const o of this.orders().filter(o=>['signed','submitted'].includes(o.status)))try{await this.reconcile(o);}catch{}}finally{this.busy=false;}}
 async balance(agent){let row=this.store.get('live-balances',agent.id);if(!row||Date.now()-row.at>15000)try{row={id:agent.id,balanceWei:String(await this.rpc.balance(agent.address)),at:Date.now(),verified:true};this.store.put('live-balances',row);}catch{if(row)this.store.put('live-balances',{...row,verified:false});return row?{...row,verified:false}:null;}return row;}
 view(agent){const b=this.store.get('live-balances',agent.id),activity=this.store.all('live-activity').filter(x=>x.agentId===agent.id),lots=this.store.all('live-lots').filter(x=>x.agentId===agent.id&&BigInt(x.remainingRaw)>0n);return {balanceWei:b?.balanceWei??null,balanceVerified:!!b?.verified&&Date.now()-b.at<=30000,balanceAt:b?.at??null,realizedWei:String(activity.reduce((n,x)=>n+BigInt(x.netRaw??0),0n)),positions:lots,pending:this.orders(agent.id).filter(o=>pending.has(o.status)).length};}
 async stop(){this.stopped=true;await Promise.allSettled([...this.locks.values()]);while(this.busy)await new Promise(r=>setTimeout(r,20));}
}
