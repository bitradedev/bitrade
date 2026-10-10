import test from 'node:test';
import assert from 'node:assert/strict';
import {fetch,Response} from 'undici';
import {ConfirmedBscHeaders,readBscBlockReceipts} from '../src/server/adapters/bsc-block-reader.js';
import {ReadRpc} from '../src/server/adapters/rpc.js';
import {LiveGateway} from '../src/server/gateway.js';
import {encodeAbiParameters,getEventSelector} from 'viem';
import {address,ZERO,FLAP} from '../src/server/adapters/types.js';

const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const header=(n:number)=>({number:'0x'+n.toString(16),timestamp:'0x64',hash:hash(n),parentHash:hash(n-1)});
class Socket extends EventTarget {
 readyState=1;sent:any[]=[];
 send(data:string){this.sent.push(JSON.parse(data));}
 message(body:any){this.dispatchEvent(new MessageEvent('message',{data:typeof body==='string'?body:JSON.stringify(body)}));}
 reply(index:number,result:any=[]){this.message({jsonrpc:'2.0',id:this.sent[index].id,result});}
}

test('subscription headers are bounded, validated, exact-fork and independent of full blocks',()=>{
 const cache=new ConfirmedBscHeaders();
 for(let n=1;n<=300;n++)cache.observe(header(n));
 assert.equal(cache.match(44,hash(44)),undefined);
 assert.deepEqual(cache.match(45,hash(45)),{number:45,hash:hash(45),parentHash:hash(44),time:100000});
 assert.equal(cache.match(300,hash(299)),undefined);assert.equal(cache.match(300,'not-a-hash'),undefined);
 assert.equal('transactions' in cache.match(300,hash(300))!,false);
 const copy=cache.match(300,hash(300))!;copy.time=1;assert.equal(cache.match(300,hash(300))!.time,100000);
 cache.invalidate(290);assert(cache.match(289,hash(289)));assert.equal(cache.match(290,hash(290)),undefined);
 cache.invalidate();assert.equal(cache.match(289,hash(289)),undefined);
 for(const value of [{...header(1),hash:'bad'},{...header(1),parentHash:'bad'},{...header(1),number:'0x01'},{...header(1),number:'0xfffffffffffffff'},{...header(1),timestamp:'0x0'},{...header(1),timestamp:'0xfffffffffffff'},null])cache.observe(value);
 assert.equal(cache.match(1,hash(1)),undefined);
});

test('shared feed receipts send only the fixed read method and correlate concurrent responses',async()=>{
 const socket=new Socket();const first=readBscBlockReceipts(socket,'0x64'),second=readBscBlockReceipts(socket,'0x65');
 assert.deepEqual(socket.sent.map(row=>[row.method,row.params]),[['eth_getBlockReceipts',['0x64']],['eth_getBlockReceipts',['0x65']]]);
 assert.notEqual(socket.sent[0].id,socket.sent[1].id);assert.match(socket.sent[0].id,/^paper:block-receipts:/);
 socket.message('malformed');socket.message({jsonrpc:'2.0',id:123,result:'feed-owned'});socket.message({method:'eth_subscription',params:{result:header(100)}});
 socket.reply(1,[{transactionHash:hash(2)}]);socket.reply(0,[{transactionHash:hash(1)}]);
 assert.deepEqual(await first,[{transactionHash:hash(1)}]);assert.deepEqual(await second,[{transactionHash:hash(2)}]);
});

test('invalid or unavailable sockets cannot send any RPC',async()=>{
 const socket=new Socket();for(const value of ['latest','pending','0x01','0x-1','0xfffffffffffffff','eth_sendTransaction'])await assert.rejects(readBscBlockReceipts(socket,value),/实际区块号/);
 socket.readyState=3;await assert.rejects(readBscBlockReceipts(socket,'0x64'),/尚未就绪/);await assert.rejects(readBscBlockReceipts(undefined,'0x64'),/尚未就绪/);assert.equal(socket.sent.length,0);
});

test('RPC errors and malformed correlated receipts remain failures',async()=>{
 for(const body of [{error:{message:'header not found'}},{result:null},{result:[] ,jsonrpc:'1.0'}]){
  const socket=new Socket(),pending=readBscBlockReceipts(socket,'0x64');socket.message({jsonrpc:'2.0',id:socket.sent[0].id,...body});await assert.rejects(pending);
 }
});

test('closing, errors, send exceptions and timeouts clean every temporary listener',async()=>{
 for(const failure of ['close','error','timeout','send'] as const){
  const socket=new Socket(),listeners=new Map<string,Set<any>>();const add=socket.addEventListener.bind(socket),remove=socket.removeEventListener.bind(socket);
  socket.addEventListener=(type,listener,options)=>{const set=listeners.get(type)??new Set();set.add(listener);listeners.set(type,set);add(type,listener,options);};
  socket.removeEventListener=(type,listener,options)=>{listeners.get(type)?.delete(listener);remove(type,listener,options);};
  if(failure==='send')socket.send=()=>{throw Error('send failed');};
  const pending=readBscBlockReceipts(socket,'0x64',10);if(failure==='close'||failure==='error')socket.dispatchEvent(new Event(failure));await assert.rejects(pending);
  assert.equal([...listeners.values()].reduce((sum,set)=>sum+set.size,0),0);
 }
});

test('successful responses also remove temporary listeners without touching feed listeners',async()=>{
 const socket=new Socket();let feedMessages=0;socket.addEventListener('message',()=>feedMessages++);
 const pending=readBscBlockReceipts(socket,'0x64');socket.reply(0);assert.deepEqual(await pending,[]);socket.message({id:socket.sent[0].id,result:[]});assert.equal(feedMessages,2);
});

const http=(calls:string[])=>((async(_url:any,options:any)=>{const method=JSON.parse(options.body).method;calls.push(method);return new Response(JSON.stringify({result:method==='eth_chainId'?'0x38':[]}));}) as typeof fetch);

test('ReadRpc paces the shared WS batch while keeping the HTTP chain check',async()=>{
 const calls:string[]=[],rpc=new ReadRpc('bsc','',undefined,http(calls));let reads=0;
 rpc.setBlockReceiptReader(async block=>{reads++;assert.equal(block,'0x64');return [{transactionHash:hash(1),blockNumber:block,blockHash:hash(100),logs:[]}];});
 try{await rpc.withPriority(()=>rpc.receipt(hash(1),100));assert.deepEqual(calls,['eth_chainId']);assert.equal(reads,1);assert.equal(rpc.queueStats().intervalMs,180);}finally{await rpc.close();}
});

test('a disconnected shared reader falls back through the same paced HTTP batch',async()=>{
 const calls:string[]=[],rpc=new ReadRpc('bsc','',undefined,http(calls));rpc.setBlockReceiptReader(async()=>{throw Error('disconnected');});
 try{await rpc.verify();assert.deepEqual(await rpc.withPriority(()=>rpc.request('eth_getBlockReceipts',['0x64'])),[]);assert.deepEqual(calls,['eth_chainId','eth_getBlockReceipts']);}finally{await rpc.close();}
});

test('a canceled WS read keeps its network slot until settlement and never starts HTTP fallback',async()=>{
 const calls:string[]=[],rpc=new ReadRpc('bsc','',undefined,http(calls));let entered!:()=>void,release!:(value:any[])=>void;
 const started=new Promise<void>(r=>entered=r);rpc.setBlockReceiptReader(()=>{entered();return new Promise(r=>release=r);});
 try{await rpc.verify();const pending=rpc.request('eth_getBlockReceipts',['0x64']);await started;const closed=rpc.close();await assert.rejects(pending,/已停止/);assert.equal(rpc.queueStats().active,1);release([]);await closed;await new Promise(r=>setTimeout(r,0));assert.equal(rpc.queueStats().active,0);assert.deepEqual(calls,['eth_chainId']);}finally{release?.([]);await rpc.close();}
});

test('Robinhood transport is unchanged even if a BSC reader was registered',async()=>{
 const calls:string[]=[],rpc=new ReadRpc('robinhood','',undefined,http(calls));rpc.setBlockReceiptReader(async()=>{throw Error('must not run');});
 try{assert.deepEqual(await rpc.request('eth_getBlockReceipts',['0x64']),[]);assert.deepEqual(calls,['eth_getBlockReceipts']);}finally{await rpc.close();}
});

test('trade proof reuses an exact subscription header, requires real receipts and falls back on fork mismatch',async()=>{
 const token=address('0x'+'1'.repeat(40)),owner=address('0x'+'3'.repeat(40));
 for(const fork of ['match','mismatch','missing','failed-receipt'] as const){
  const g=new LiveGateway({proxy:''}) as any,events:any[]=[];let blockReads=0;
  g.emit=(event:any)=>events.push(event);g.discovered('bsc',token,100,0);g.catalog.get('bsc:'+token).decimals=6;
  g.routes.set('bsc:'+token,{block:100,route:{kind:'flap',token,quote:ZERO}});g.fx=async()=>({usd:1000,at:Date.now(),mono:performance.now()});g.venues.bsc.decimals=async(a:string)=>a===token?6:18;g.venues.bsc.conversion=async()=>null;
  g.rpc.bsc.block=async()=>{blockReads++;return {number:100,time:100000,hash:hash(100),transactions:[hash(1)]};};
  if(fork!=='missing')g.bscHeaders.observe({...header(100),hash:hash(fork==='mismatch'?99:100)});
  const log={address:FLAP,blockHash:hash(100),blockNumber:'0x64',transactionHash:hash(1),logIndex:'0x1',topics:[getEventSelector('TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)')],data:encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[1n,token,owner,2000000n,10000000000000000n,100000000000000n,1n])};
  const transfer={address:token,topics:[getEventSelector('Transfer(address,address,uint256)'),'0x'+ZERO.slice(2).padStart(64,'0'),'0x'+owner.slice(2).padStart(64,'0')],data:'0x'+(2000000n).toString(16)};
  g.rpc.bsc.receipt=async()=>({status:fork==='failed-receipt'?'0x0':'0x1',from:owner,blockHash:hash(100),blockNumber:'0x64',transactionHash:hash(1),gasUsed:'0x5208',logs:[log,transfer]});g.gas.bsc.observe=async()=>{};
  try{await g.tradeLog('bsc',log,false);const event=events.find(row=>row.kind==='trade');assert.equal(event.payload.verified,fork!=='failed-receipt');assert.equal(event.payload.rawChainAt,100000);assert.equal(blockReads,fork==='missing'||fork==='mismatch'?1:0);assert.equal(g.rpc.bsc.knownBlock(100),undefined);if(fork==='failed-receipt')assert.equal(g.candleRows.size,0);}finally{await g.stop();}
 }
});

test('reconnection removes old headers and reorganization invalidates the affected fork',async()=>{
 const g=new LiveGateway({proxy:''}) as any,first=new Socket(),second=new Socket();g.running=true;g.feed={ws:first,subscriptions:new Map([['heads-sub','heads'],['logs-sub','logs']])};
 try{g.attachFeedSocket();first.message({method:'eth_subscription',params:{subscription:'heads-sub',result:header(100)}});assert(g.bscHeaders.match(100,hash(100)));
  await g.reorg('bsc',100);assert.equal(g.bscHeaders.match(100,hash(100)),undefined);
  first.message({method:'eth_subscription',params:{subscription:'heads-sub',result:header(101)}});assert(g.bscHeaders.match(101,hash(101)));
  g.feed.ws=second;g.attachFeedSocket();assert.equal(g.bscHeaders.match(101,hash(101)),undefined);
  first.message({method:'eth_subscription',params:{subscription:'heads-sub',result:header(102)}});second.message({method:'eth_subscription',params:{subscription:'logs-sub',result:header(103)}});
  assert.equal(g.bscHeaders.match(102,hash(102)),undefined);assert.equal(g.bscHeaders.match(103,hash(103)),undefined);
  second.message({method:'eth_subscription',params:{subscription:'heads-sub',result:header(104)}});assert(g.bscHeaders.match(104,hash(104)));
 }finally{g.running=false;await g.stop();}
});
