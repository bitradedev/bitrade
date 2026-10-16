import { getEventSelector } from 'viem';
import type { ReadRpc } from './rpc.js';
const hexBlock=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid block number');return '0x'+n.toString(16);};
import { RouteBlocked,FLAP,FOUR_MANAGER,CHAIN_CONFIG,capMap,type Route,type GasContext } from './types.js';
const trades=new Set([
 'Swap(address,uint256,uint256,uint256,uint256,address)',
 'Swap(address,address,int256,int256,uint160,uint128,int24)',
 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
 'TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)',
 'TokenSold(uint256,address,address,uint256,uint256,uint256,uint256)',
 'TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
 'TokenSale(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
 'CurveBuy(address,address,uint256,uint256,uint256,uint256)',
 'CurveSell(address,address,uint256,uint256,uint256,uint256)',
].map(getEventSelector));
export class ReceiptGas {
 private samples:{block:number;gas:bigint;tx:string;venue:string}[]=[];private warming:Promise<void>|null=null;private observing=false;private lastObserved=0;
 private contexts=new Map<string,Promise<GasContext>>();private gasPrices=new Map<number,Promise<{raw:bigint;at:number}>>();private revision=0;
 constructor(private rpc:ReadRpc){}
 async observe(tx:string,venue='market'){if(this.observing||performance.now()-this.lastObserved<10000)return;this.observing=true;try{await this.capture(tx,venue);this.lastObserved=performance.now();}finally{this.observing=false;}}
 private async capture(tx:string,venue='market'){const revision=this.revision,receipt=await this.rpc.receipt(tx);if(this.revision!==revision||!receipt||receipt.status!=='0x1'||!receipt.logs.some(l=>trades.has(l.topics[0])))return;
  if(!this.samples.some(s=>s.tx===tx)){this.samples.push({block:Number(BigInt(receipt.blockNumber)),gas:BigInt(receipt.gasUsed),tx,venue});this.samples=this.samples.slice(-30);}
 }
 private async warm(block:number,route:Route){
  if(this.rpc.chain==='bsc'){
   if(this.rpc.receipts){
    const revision=this.revision;
    for(let delta=0;delta<4;delta++){
     const b=await this.rpc.block(block-delta),txs=b.transactions.slice(-12);if(!txs.length)continue;
     const receipts=await this.rpc.receipts(txs);if(this.revision!==revision)throw new RouteBlocked('GAS_REORG','读取 Gas 批次期间发生重组');
     for(let i=0;i<receipts.length;i++){
      const receipt=receipts[i];if(!receipt||receipt.status!=='0x1'||!receipt.logs.some(l=>trades.has(l.topics[0])))continue;
      const contracts=receipt.logs.map(l=>l.address.toLowerCase()),matching=route.kind==='flap'?contracts.includes(FLAP):route.kind==='four'?contracts.includes(FOUR_MANAGER):route.pool?contracts.includes(route.pool):false;
      if(!this.samples.some(s=>s.tx===txs[i]))this.samples.push({block:Number(BigInt(receipt.blockNumber)),gas:BigInt(receipt.gasUsed),tx:txs[i],venue:matching?route.kind:'market'});
      this.samples=this.samples.slice(-30);if(this.samples.length>=3||matching)return;
     }
     if(this.samples.length)return;
    }
    return;
   }
   for(let delta=0;delta<4;delta++){const b=await this.rpc.block(block-delta);for(const tx of b.transactions.slice(-12)){const receipt=await this.rpc.receipt(tx);if(!receipt||receipt.status!=='0x1'||!receipt.logs.some(l=>trades.has(l.topics[0])))continue;const contracts=receipt.logs.map(l=>l.address.toLowerCase());const matching=route.kind==='flap'?contracts.includes(FLAP):route.kind==='four'?contracts.includes(FOUR_MANAGER):route.pool?contracts.includes(route.pool):false;await this.capture(tx,matching?route.kind:'market');if(this.samples.length>=3||matching)return;}if(this.samples.length)return;}return;
  }
  const specific=[route.pool,route.curve,route.kind==='flap'?FLAP:route.kind==='four'?FOUR_MANAGER:route.kind==='v4'?CHAIN_CONFIG.robinhood.v4Manager:undefined].filter(Boolean);
  const fallback=[CHAIN_CONFIG.robinhood.v4Manager];
  for(const [index,addresses] of [specific,fallback].entries()){if(!addresses.length)continue;const logs=await this.rpc.logs({address:[...new Set(addresses)],fromBlock:hexBlock(Math.max(0,block-127)),toBlock:hexBlock(block),topics:[[...trades]]});const txs=[...new Set(logs.slice(-20).map(l=>l.transactionHash))].slice(-4);for(const tx of txs)await this.capture(tx,index===0?route.kind:'market');if(this.samples.length)break;}
 }
 async context(route:Route,block:number):Promise<GasContext>{
  const key=route.kind+':'+block;const cached=this.contexts.get(key);if(cached){const price=this.gasPrices.get(block);if(price)this.rpc.promote(price);return cached;}
  const pending=this.captureContext(route,block,this.revision);this.contexts.set(key,pending);capMap(this.contexts,256);
  void pending.catch(()=>{if(this.contexts.get(key)===pending)this.contexts.delete(key);});return pending;
 }
 private async captureContext(route:Route,block:number,revision:number):Promise<GasContext>{
  if(!this.samples.some(s=>s.block<=block&&block-s.block<10000)){if(!this.warming)this.warming=this.warm(block,route).finally(()=>{this.warming=null;});await this.warming;}
  if(this.revision!==revision)throw new RouteBlocked('GAS_REORG','读取 Gas 样本期间发生重组，请重新报价');
  const candidates=this.samples.filter(s=>s.block<=block&&block-s.block<10000);if(!candidates.length)throw new RouteBlocked('GAS_SAMPLE_UNKNOWN','缺少近期真实成交 Gas 样本，暂停报价');
  const matching=candidates.filter(s=>s.venue===route.kind);const sorted=(matching.length?matching:candidates).slice().sort((a,b)=>a.gas<b.gas?-1:a.gas>b.gas?1:0);const sample=sorted[Math.max(0,Math.ceil(sorted.length*.75)-1)];
  let price=this.gasPrices.get(block);if(price)this.rpc.promote(price);else{const read=this.rpc.request<string>('eth_gasPrice'),pending=this.rpc.linkPending(read.then(raw=>({raw:BigInt(raw),at:Date.now()})),read);this.gasPrices.set(block,pending);capMap(this.gasPrices,128);void pending.catch(()=>{if(this.gasPrices.get(block)===pending)this.gasPrices.delete(block);});price=pending;}
  const frozen=await price;if(this.revision!==revision)throw new RouteBlocked('GAS_REORG','读取 Gas 价格期间发生重组，请重新报价');
  return Object.freeze({gasUsedRaw:sample.gas.toString(),gasPriceRaw:frozen.raw.toString(),sampleBlock:sample.block,sampleTransaction:sample.tx,sourceFeeFrozenAt:frozen.at});
 }
 async estimate(route:Route,block:number,side:'buy'|'sell',nativeUsd:number,legs:number,frozen?:GasContext){
  const context=frozen??await this.context(route,block);if(context.sampleBlock>block)throw new RouteBlocked('FUTURE_GAS_SAMPLE','不能用未来 Gas 样本给历史模拟定价');
  if(!Number.isFinite(context.sourceFeeFrozenAt)||context.sourceFeeFrozenAt<=0)throw new RouteBlocked('GAS_FREEZE_UNKNOWN','费用快照缺少实际读取冻结时间，请重新采集');
  const sample={gas:BigInt(context.gasUsedRaw),tx:context.sampleTransaction},gasPrice=BigInt(context.gasPriceRaw);
  // Paper accounts hold native ETH. A WETH pair needs an explicit wrap on
  // entry and unwrap on exit; use another real-swap proxy step conservatively
  // rather than silently assuming the wrapper transaction is free.
  const wrappedQuote=this.rpc.chain==='robinhood'&&route.quote.toLowerCase()===CHAIN_CONFIG.robinhood.wrapped;
  const steps=legs+(wrappedQuote?1:0),gasRaw=sample.gas*gasPrice*BigInt(steps);
  // Approval is an explicit conservative estimate derived from a real swap's
  // gas use, never a purported gas estimate from a funded sender simulation.
  const approvalUnits=sample.gas/4n>21000n?sample.gas/4n:21000n;
  const approvals=(side==='sell'?1:0)+(legs>1?1:0)+(wrappedQuote&&side==='buy'?1:0),approvalRaw=approvalUnits*gasPrice*BigInt(approvals);
  return {gasUsd:Number(gasRaw)/1e18*nativeUsd,approvalUsd:Number(approvalRaw)/1e18*nativeUsd,sourceFeeFrozenAt:context.sourceFeeFrozenAt,notes:[`Gas 估计：近期真实成交 p75 样本 ${sample.tx} 的 ${sample.gas} gas × 实际读取后冻结的 gasPrice（${new Date(context.sourceFeeFrozenAt).toISOString()}）；${steps} 个交易步骤；优先同协议，缺失时为跨协议保守代理样本`,...(wrappedQuote?[`WETH ${side==='buy'?'包装及报价币首次授权':'解包'}另计；包装/解包沿用整笔真实 swap 的 Gas 作为保守代理，未实测执行`]:[]),`授权估计：${approvals} 次，每次按真实成交 gas 的 25%（最低 21000）；虚拟首次授权保守计费，未使用签名或真实余额`,`Gas/授权费在报价金额之外；报价 Gas 估计不等于实际发送成本${this.rpc.chain==='robinhood'?'，L2 当前 gasPrice 已含链费用规则，未另造 L1 成本':''}`]};
 }
 invalidate(fromBlock:number){this.revision++;this.samples=this.samples.filter(s=>s.block<fromBlock);for(const key of this.contexts.keys())if(Number(key.slice(key.lastIndexOf(':')+1))>=fromBlock)this.contexts.delete(key);for(const block of this.gasPrices.keys())if(block>=fromBlock)this.gasPrices.delete(block);}
}
