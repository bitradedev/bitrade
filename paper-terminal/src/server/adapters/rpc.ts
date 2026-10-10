import { fetch, ProxyAgent, Response } from 'undici';
import {request as httpsRequest} from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import type { Audit, Chain } from './types.js';
import { address, CHAIN_CONFIG, ORDINARY_RECIPIENT, RouteBlocked } from './types.js';
import { rpcScheduler,type RpcPriority } from './scheduler.js';

export const READ_ONLY_METHODS=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBlockReceipts','eth_getLogs','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getCode','eth_call','eth_gasPrice']);
const QUOTE_FUNCTIONS=new Set(['quoteExactInput','quoteExactInputSingle','quoteExactOutputSingle']);
export function assertReadOnly(method:string){if(!READ_ONLY_METHODS.has(method))throw new RouteBlocked('READ_ONLY','网关只允许公开只读 RPC');}
export interface PublicReceipt {status:string;from:string;to:string;gasUsed:string;effectiveGasPrice?:string;blockNumber:string;blockHash?:string;transactionHash:string;logs:any[];}
interface Context {priority:RpcPriority;deadline?:number;}
class RetryHttp extends Error {}
class RetryEndpoint extends Error {constructor(readonly status:number){super('Public BSC endpoint unavailable');}}
class RetryDirectTransport extends Error {}
class RetryProxyTransport extends Error {}
// The public Robinhood endpoint accepts Node's standard HTTPS client more
// reliably than undici's direct connection. Keep the same official URL,
// read-only method gate, cancellation and shared request budget.
const nativeHttpFetch=(async(url:any,options:any)=>new Promise<Response>((resolve,reject)=>{
 const req=httpsRequest(String(url),{method:options.method,headers:options.headers,signal:options.signal},res=>{
  const chunks:Buffer[]=[];let bytes=0;
  res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>16*1024*1024){req.destroy(new Error('只读RPC响应超过16MB'));return;}chunks.push(chunk);});
  res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode??502,headers:res.headers as Record<string,string>})));
 });req.on('error',reject);req.end(options.body);
})) as typeof fetch;
export class ReadRpc {
 receipts?: (hashes:string[])=>Promise<(PublicReceipt|null)[]>;
 endpoint:string;private dispatcher?:ProxyAgent;private directTransport=false;private id=0;private verified=false;private verification?:Promise<void>;private closed=false;private calls=new Map<string,Promise<any>>();private blocks=new Map<number,any>();private alternate=false;private cacheRevision=0;
 private priorityContext=new AsyncLocalStorage<Context>();private logReader?:((filter:Record<string,unknown>)=>Promise<any[]>);private blockReceiptReader?:((block:string)=>Promise<any[]>);
 private lastBackoffAudit=-Infinity;
 private lastTransportSwitch=-Infinity;
 private directFetch:typeof fetch;
 private receiptBlocks=new Map<number,Promise<Map<string,PublicReceipt>>>();private receiptBatchRetryAt=0;
 constructor(readonly chain:Chain,proxy='http://127.0.0.1:7897',private audit?:Audit,private httpFetch:typeof fetch=fetch){this.endpoint=CHAIN_CONFIG[chain].http;if(proxy)this.dispatcher=new ProxyAgent(proxy);this.directFetch=httpFetch===fetch?nativeHttpFetch:httpFetch;}
 withPriority<T>(fn:()=>Promise<T>):Promise<T>{return this.withLane('foreground',fn);}
 // Queued event work begins after its scanner may already have expired. Each
 // proof needs its own execution budget; retain pacing and the signal's
 // original receive time instead of inheriting the scanner/previous proof's.
 withProofBudget<T>(fn:()=>Promise<T>,replayed:boolean):Promise<T>{return this.priorityContext.exit(()=>replayed?this.withBackground(fn,this.chain==='bsc'?5000:undefined):this.withPriority(fn));}
 withBackground<T>(fn:()=>Promise<T>,budgetMs?:number):Promise<T>{return budgetMs===undefined?this.priorityContext.run({priority:'background',deadline:this.priorityContext.getStore()?.deadline},fn):this.withLane('background',fn,budgetMs);}
 private withLane<T>(priority:RpcPriority,fn:()=>Promise<T>,budgetMs=5000):Promise<T>{const existing=this.priorityContext.getStore(),deadline=Math.min(existing?.deadline??Infinity,performance.now()+budgetMs);return this.priorityContext.run({priority,deadline},async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([fn(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RouteBlocked('RPC_DEADLINE',`${priority} 只读核验超过${budgetMs/1000}秒预算`)),Math.max(1,deadline-performance.now()));})]);}finally{if(timer)clearTimeout(timer);}});}
 setLogReader(reader:(filter:Record<string,unknown>)=>Promise<any[]>){this.logReader=reader;}
 setBlockReceiptReader(reader:(block:string)=>Promise<any[]>){this.blockReceiptReader=reader;}
 linkPending<T>(target:Promise<T>,source:Promise<unknown>){return rpcScheduler.link(target,source);}
 promote(promise:Promise<unknown>){const context=this.priorityContext.getStore();if(context)rpcScheduler.promote(promise,context.priority,context.deadline);}
 queueStats(){return rpcScheduler.stats();}
 isForeground(){return this.priorityContext.getStore()?.priority==='foreground';}
 private rateLimited(method:string){rpcScheduler.pause(10000,this);const now=performance.now();if(now-this.lastBackoffAudit>=10000){this.lastBackoffAudit=now;this.audit?.('gateway','只读节点限频，暂停该链请求；另一条链继续使用独立预算',{chain:this.chain,endpoint:this.endpoint,method,pauseMs:10000});}}
 request<T=any>(method:string,params:unknown[]=[],priority=false):Promise<T>{return this.enqueue<T>(method,params,priority,false);}
 private enqueue<T>(method:string,params:unknown[],head:boolean,httpOnly:boolean):Promise<T>{
  try{assertReadOnly(method);if(this.closed)throw new RouteBlocked('RPC_STOPPED','只读网关已停止');}catch(error){return Promise.reject(error);}
  // A transport change invalidates prior chain and cache proofs. Every resumed
  // read shares the new chain check, including callers of the raw request API.
  if(Number.isFinite(this.lastTransportSwitch)&&!this.verified&&method!=='eth_chainId'){const proof=this.verify();return this.linkPending(proof.then(()=>this.enqueue<T>(method,params,head,httpOnly)),proof);}
  const context=this.priorityContext.getStore(),priority=head?'head':context?.priority??'background';
  const job=rpcScheduler.schedule<T>(this,priority,signal=>this.transport<T>(method,params,signal,httpOnly),context?.deadline);
  const result=job.catch(async(error:unknown)=>{
   if(error instanceof RetryHttp&&!httpOnly)return this.enqueue<T>(method,params,head,true);
   if(error instanceof RetryDirectTransport){if(!this.directTransport){this.directTransport=true;this.lastTransportSwitch=performance.now();this.verified=false;this.verification=undefined;this.clearCache();this.audit?.('gateway','Robinhood 代理请求被拒绝，改用同一官方节点的直接只读连接',{status:403,endpoint:this.endpoint,settingsChanged:false});}await this.verify();return this.enqueue<T>(method,params,head,true);}
   if(error instanceof RetryProxyTransport){if(this.directTransport){this.directTransport=false;this.lastTransportSwitch=performance.now();this.verified=false;this.verification=undefined;this.clearCache();this.audit?.('gateway','Robinhood 直连仍被拒绝，冷却后恢复原代理的只读连接',{status:403,endpoint:this.endpoint,settingsChanged:false});}await this.verify();return this.enqueue<T>(method,params,head,true);}
   if(error instanceof RetryEndpoint&&!this.alternate){this.alternate=true;this.endpoint='https://bsc-dataseed.bnbchain.org';this.verified=false;this.verification=undefined;this.audit?.('gateway','BSC 公共节点拒绝请求，切换 BNB Chain 官方公开端点',{status:error.status,endpoint:this.endpoint});await this.verify();return this.enqueue<T>(method,params,head,true);}
   throw error;
  });return this.linkPending(result,job);
 }
 private async transport<T>(method:string,params:unknown[],signal:AbortSignal,httpOnly:boolean):Promise<T>{
  // Existing feed RPC cannot cancel an individual WS request. Keep its slot
  // until the underlying promise settles, even if the caller times out.
  if(method==='eth_getLogs'&&this.logReader&&!httpOnly){try{return await this.logReader(params[0] as Record<string,unknown>) as T;}catch(error){if(signal.aborted)throw signal.reason;throw new RetryHttp();}}
  if(this.chain==='bsc'&&method==='eth_getBlockReceipts'&&this.blockReceiptReader&&!httpOnly){try{return await this.blockReceiptReader(params[0] as string) as T;}catch(error){if(signal.aborted)throw signal.reason;throw new RetryHttp();}}
  const dispatcher=this.directTransport?undefined:this.dispatcher;
  const headers={'content-type':'application/json',...(this.chain==='robinhood'?{'user-agent':'PaperResearch/1.0 (local read-only simulation)'}:{})};
  const http=this.chain==='robinhood'&&!dispatcher?this.directFetch:this.httpFetch;
  const response=await http(this.endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method,params}),dispatcher,signal});
  if(!response.ok){await response.body?.cancel();if(response.status===429)this.rateLimited(method);if(this.chain==='robinhood'&&response.status===403){if(dispatcher&&(this.directTransport||performance.now()-this.lastTransportSwitch>=30000))throw new RetryDirectTransport();if(!dispatcher&&this.dispatcher&&(!this.directTransport||performance.now()-this.lastTransportSwitch>=30000))throw new RetryProxyTransport();}if(this.chain==='bsc'&&[403,429].includes(response.status)&&!this.alternate)throw new RetryEndpoint(response.status);throw new RouteBlocked('RPC_HTTP',`只读 RPC HTTP ${response.status}`);}
  const body=await response.json() as any;if(body.error){if(/rate.limit|too many|429/i.test(String(body.error.message)))this.rateLimited(method);throw new RouteBlocked('RPC_ERROR',String(body.error.message).slice(0,250));}return body.result as T;
 }
 verify():Promise<void>{if(this.verified)return Promise.resolve();if(this.verification){this.promote(this.verification);return this.verification;}const read=this.request<string>('eth_chainId'),pending=read.then(id=>{if(BigInt(id)!==BigInt(CHAIN_CONFIG[this.chain].id))throw new RouteBlocked('WRONG_CHAIN','RPC 返回了错误的链');if(this.verification===pending)this.verified=true;});this.verification=this.linkPending(pending,read);void pending.catch(()=>{if(this.verification===pending)this.verification=undefined;});return pending;}
 async read<T=any>(contract:Address,abi:Abi,name:string,args:readonly unknown[]=[],block?:number,from:Address=ORDINARY_RECIPIENT):Promise<T>{
  const fn=abi.find((i:any)=>i.type==='function'&&i.name===name) as any;if(!fn||(!['view','pure'].includes(fn.stateMutability)&&!QUOTE_FUNCTIONS.has(name)))throw new RouteBlocked('READ_ONLY','不允许调用交易、授权或签名方法');
  await this.verify();const revision=this.cacheRevision,data=encodeFunctionData({abi,functionName:name,args} as any);
  const params=[{to:address(contract),data,from:address(from)},block===undefined?'latest':hexBlock(block)];const cacheKey=JSON.stringify(params);let call=block===undefined?undefined:this.calls.get(cacheKey);
  if(call)this.promote(call);else{const pending=this.request<Hex>('eth_call',params);call=pending;if(block!==undefined){this.calls.set(cacheKey,pending);while(this.calls.size>4096)this.calls.delete(this.calls.keys().next().value!);void pending.catch(()=>{if(this.calls.get(cacheKey)===pending)this.calls.delete(cacheKey);});}}
  const result=await call;if(revision!==this.cacheRevision)throw new RouteBlocked('RPC_REORG','读取期间区块缓存失效，请重新核实报价');return decodeFunctionResult({abi,functionName:name,data:result} as any) as T;
 }
 async block(n?:number,priority=false,force=false):Promise<any>{if(priority)return this.withLane('head',()=>this.block(n,false,force));if(!force&&n!==undefined&&this.blocks.has(n))return this.blocks.get(n);await this.verify();const revision=this.cacheRevision,b=await this.request<any>('eth_getBlockByNumber',[n===undefined?'latest':hexBlock(n),false]);if(revision!==this.cacheRevision)throw new RouteBlocked('RPC_REORG','读取区块期间缓存失效，请重新核实');if(!b)throw new RouteBlocked('BLOCK_MISSING','区块不可用');const result={number:Number(BigInt(b.number)),hash:b.hash as string,parentHash:b.parentHash as string,time:Number(BigInt(b.timestamp))*1000,transactions:b.transactions as string[]};this.blocks.set(result.number,result);while(this.blocks.size>256)this.blocks.delete(this.blocks.keys().next().value!);return result;}
 knownBlock(n:number){return this.blocks.get(n);}
 async logs(filter:Record<string,unknown>){await this.verify();return this.request<any[]>('eth_getLogs',[filter]);}
 async receipt(tx:string,block?:number):Promise<PublicReceipt|null>{
  if(!/^0x[0-9a-f]{64}$/i.test(tx))throw Error('Invalid transaction hash');
  // A busy launch can contain many trades in one block. Share the real block
  // receipts instead of spending one paced HTTP request on every trade.
  // Other chains and unsupported endpoints retain the individual read path.
  if(this.chain==='bsc'&&block!==undefined){hexBlock(block);await this.verify();const revision=this.cacheRevision;
   let batch=this.receiptBlocks.get(block);
   if(!batch&&performance.now()>=this.receiptBatchRetryAt){const read=this.request<PublicReceipt[]>('eth_getBlockReceipts',[hexBlock(block)]);
    batch=this.linkPending(read.then(rows=>{
     if(revision!==this.cacheRevision)throw new RouteBlocked('RPC_REORG','读取回执期间区块缓存失效，请重新核实');
     if(!Array.isArray(rows)||rows.length>4096)throw new RouteBlocked('RECEIPTS_INVALID','区块回执响应无效');
     const result=new Map<string,PublicReceipt>();let hash:string|undefined;
     for(const row of rows){if(!row||row.blockNumber!==hexBlock(block)||!/^0x[0-9a-f]{64}$/i.test(row.blockHash??'')||!/^0x[0-9a-f]{64}$/i.test(row.transactionHash)||!Array.isArray(row.logs))throw new RouteBlocked('RECEIPTS_INVALID','区块回执身份或区块不一致');
      const current=row.blockHash!.toLowerCase(),id=row.transactionHash.toLowerCase();if(hash&&hash!==current||result.has(id))throw new RouteBlocked('RECEIPTS_INVALID','区块回执包含混合分叉或重复交易');hash=current;result.set(id,row);
     }return result;
    }),read);this.receiptBlocks.set(block,batch);while(this.receiptBlocks.size>64)this.receiptBlocks.delete(this.receiptBlocks.keys().next().value!);
    void batch.catch(error=>{if(this.receiptBlocks.get(block)===batch)this.receiptBlocks.delete(block);if(revision===this.cacheRevision){this.receiptBatchRetryAt=performance.now()+30000;this.audit?.('gateway','区块回执批量读取不可用，保留逐笔核验',{chain:this.chain,block,reason:error instanceof Error?error.message:String(error)});}});
   }
   if(batch){this.promote(batch);try{const rows=await batch;if(revision!==this.cacheRevision)throw new RouteBlocked('RPC_REORG','读取回执期间区块缓存失效，请重新核实');const found=rows.get(tx.toLowerCase());if(found)return found;}catch(error){if(revision!==this.cacheRevision||error instanceof RouteBlocked&&error.code==='RPC_REORG')throw error;}}
  }
  return this.request<PublicReceipt|null>('eth_getTransactionReceipt',[tx]);
 }
 clearCache(){this.cacheRevision++;this.calls.clear();this.blocks.clear();this.receiptBlocks.clear();}
 async close(){this.closed=true;rpcScheduler.cancel(this);await this.dispatcher?.close();}
}
export function hexBlock(n:number){if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid block');return '0x'+n.toString(16);}
