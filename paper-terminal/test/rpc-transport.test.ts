import test from 'node:test';
import assert from 'node:assert/strict';
import {fetch,Response} from 'undici';
import {ReadRpc} from '../src/server/adapters/rpc.js';
import {rpcScheduler} from '../src/server/adapters/scheduler.js';
import {CHAIN_CONFIG} from '../src/server/adapters/types.js';

type Call={method:string;proxied:boolean;endpoint:string;signal:AbortSignal};
const result=(value:unknown)=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:value}),{status:200});
const denied=()=>new Response('denied',{status:403});
const fake=(calls:Call[],reply:(call:Call)=>Promise<Response>|Response)=>((async(url:any,options:any)=>{const call={method:JSON.parse(options.body).method,proxied:!!options.dispatcher,endpoint:String(url),signal:options.signal};calls.push(call);return reply(call);}) as typeof fetch);

test('Robinhood proxy 403 resumes on the same official node after a new chain proof',async()=>{
 const calls:Call[]=[],audits:any[]=[];
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',(...a)=>audits.push(a),fake(calls,c=>c.proxied?denied():result(c.method==='eth_chainId'?'0x1237':'0x42')));
 try{assert.equal(await rpc.request('eth_blockNumber'),'0x42');assert.equal(await rpc.request('eth_gasPrice'),'0x42');assert.equal(calls[0].proxied,true);assert.deepEqual(calls.slice(1).map(c=>[c.method,c.proxied]),[['eth_chainId',false],['eth_blockNumber',false],['eth_gasPrice',false]]);assert.ok(calls.every(c=>c.endpoint===CHAIN_CONFIG.robinhood.http));assert.equal(audits.length,1);assert.equal(audits[0][2].settingsChanged,false);}finally{await rpc.close();}
});

test('a proxy rejection of the initial chain check cannot deadlock verification',async()=>{
 const calls:Call[]=[];const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',undefined,fake(calls,c=>c.proxied?denied():result('0x1237')));
 try{await rpc.verify();assert.equal(calls.filter(c=>c.proxied).length,1);assert.ok(calls.slice(1).every(c=>c.method==='eth_chainId'&&!c.proxied));}finally{await rpc.close();}
});

test('wrong-chain direct responses block the retry and subsequent raw reads, clearing old cache',async()=>{
 const calls:Call[]=[];let rejectProxy=false;
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',undefined,fake(calls,c=>{if(c.proxied&&rejectProxy)return denied();if(c.method==='eth_chainId')return result(c.proxied?'0x1237':'0x38');return result({number:'0x64',timestamp:'0x1',hash:'old',parentHash:'parent',transactions:[]});}));
 try{await rpc.block(100);assert.ok(rpc.knownBlock(100));rejectProxy=true;await assert.rejects(rpc.request('eth_gasPrice'),/错误的链/);assert.equal(rpc.knownBlock(100),undefined);await assert.rejects(rpc.request('eth_blockNumber'),/错误的链/);assert.ok(calls.filter(c=>!c.proxied).every(c=>c.method==='eth_chainId'));}finally{await rpc.close();}
});

test('concurrent rejected proxy requests share one transport switch and chain proof',async()=>{
 const calls:Call[]=[],audits:any[]=[];let chainReads=0;
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',(...a)=>audits.push(a),fake(calls,async c=>{if(c.method==='eth_chainId'){chainReads++;return result('0x1237');}if(c.proxied){await new Promise(r=>setTimeout(r,450));return denied();}return result('0x42');}));
 try{await rpc.verify();const values=await Promise.all([rpc.request('eth_blockNumber',[],true),rpc.withPriority(()=>rpc.request('eth_gasPrice'))]);assert.deepEqual(values,['0x42','0x42']);assert.equal(audits.length,1);assert.equal(chainReads,2);assert.equal(calls.filter(c=>c.proxied&&c.method!=='eth_chainId').length,2);}finally{await rpc.close();}
});

test('a delayed old proxy proof cannot override a rejected direct chain proof',async()=>{
 const calls:Call[]=[];let release!:(reply:Response)=>void,begun!:()=>void;const started=new Promise<void>(r=>{begun=r;});
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',undefined,fake(calls,c=>{if(c.proxied&&c.method==='eth_chainId'){begun();return new Promise<Response>(r=>{release=r;});}if(c.proxied)return denied();return result(c.method==='eth_chainId'?'0x38':'0x42');}));
 const oldProof=rpc.verify();try{await started;await assert.rejects(rpc.withPriority(()=>rpc.request('eth_blockNumber')),/错误的链/);release(result('0x1237'));await oldProof;await assert.rejects(rpc.request('eth_gasPrice'),/错误的链/);assert.ok(calls.filter(c=>!c.proxied).every(c=>c.method==='eth_chainId'));}finally{release(result('0x1237'));await rpc.close();}
});

test('direct rejection is retained without looping or repeatedly switching transport',async()=>{
 const calls:Call[]=[],audits:any[]=[];const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',(...a)=>audits.push(a),fake(calls,c=>!c.proxied&&c.method==='eth_chainId'?result('0x1237'):denied()));
 try{await assert.rejects(rpc.request('eth_blockNumber'),/403/);assert.equal(calls.length,3);assert.equal(audits.length,1);}finally{await rpc.close();}
 const noProxyCalls:Call[]=[];const direct=new ReadRpc('robinhood','',undefined,fake(noProxyCalls,()=>denied()));try{await assert.rejects(direct.request('eth_blockNumber'),/403/);assert.equal(noProxyCalls.length,1);}finally{await direct.close();}
});
test('after a direct 403 cooldown, the configured proxy can recover instead of remaining stuck',async()=>{
 const calls:Call[]=[],audits:any[]=[];let proxyWorks=false;
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',(...a)=>audits.push(a),fake(calls,c=>c.proxied&&proxyWorks?result(c.method==='eth_chainId'?'0x1237':'0x43'):!c.proxied&&c.method==='eth_chainId'?result('0x1237'):denied()));
 try{
  await assert.rejects(rpc.request('eth_blockNumber'),/403/);proxyWorks=true;
  // Advance only the retry guard; retain the scheduler, chain proof and transport path.
  (rpc as any).lastTransportSwitch=performance.now()-30001;
  assert.equal(await rpc.request('eth_blockNumber'),'0x43');assert.equal(await rpc.request('eth_gasPrice'),'0x43');
  assert.equal(audits.length,2);assert.equal(calls.at(-1)?.proxied,true);
 }finally{await rpc.close();}
});
test('Robinhood public RPC identifies the client as read-only research instead of the default undici agent',async()=>{
 let userAgent='';const rpc=new ReadRpc('robinhood','',undefined,(async(_url:any,options:any)=>{userAgent=options.headers['user-agent'];return result('0x1237');}) as typeof fetch);
 try{await rpc.verify();assert.equal(userAgent,'PaperResearch/1.0 (local read-only simulation)');}finally{await rpc.close();}
});

test('429 keeps the rate-limit pause and does not switch to direct transport',async t=>{
 const calls:Call[]=[],pauses:number[]=[],owners:object[]=[];t.mock.method(rpcScheduler,'pause',(ms:number,owner:object)=>{pauses.push(ms);owners.push(owner);});
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',undefined,fake(calls,()=>new Response('limited',{status:429})));
 try{await assert.rejects(rpc.request('eth_blockNumber'),/429/);assert.deepEqual(pauses,[10000]);assert.deepEqual(owners,[rpc]);assert.equal(calls.length,1);assert.equal(calls[0].proxied,true);}finally{await rpc.close();t.mock.restoreAll();}
});

test('JSON-RPC rate-limit errors also hold only the rejected chain',async t=>{
 const calls:Call[]=[],owners:object[]=[];t.mock.method(rpcScheduler,'pause',(_ms:number,owner:object)=>owners.push(owner));const rpc=new ReadRpc('robinhood','',undefined,fake(calls,()=>new Response(JSON.stringify({error:{code:-32005,message:'rate limit exceeded'}}),{status:200})));
 try{await assert.rejects(rpc.request('eth_blockNumber'),/rate limit/);assert.deepEqual(owners,[rpc]);}finally{await rpc.close();t.mock.restoreAll();}
});

test('stopping during direct re-verification aborts transport and prevents the retried read',async()=>{
 const calls:Call[]=[];let begun!:()=>void;const started=new Promise<void>(r=>{begun=r;});
 const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',undefined,fake(calls,c=>{if(c.proxied)return denied();begun();return new Promise<Response>((_resolve,reject)=>c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true}));}));
 const pending=rpc.request('eth_blockNumber');const rejected=assert.rejects(pending,/停止/);await started;await rpc.close();await rejected;assert.equal(calls.length,2);assert.equal(calls[1].method,'eth_chainId');assert.equal(calls[1].signal.aborted,true);
});

test('wallet signing and broadcasts stay blocked before and after the transport fallback',async()=>{
 const calls:Call[]=[];const rpc=new ReadRpc('robinhood','http://127.0.0.1:7897',undefined,fake(calls,c=>c.proxied?denied():result(c.method==='eth_chainId'?'0x1237':'0x42')));
 try{for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign','wallet_switchEthereumChain'])await assert.rejects(rpc.request(method),/只读/);assert.equal(calls.length,0);await rpc.request('eth_blockNumber');const count=calls.length;for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign','wallet_switchEthereumChain'])await assert.rejects(rpc.request(method),/只读/);assert.equal(calls.length,count);}finally{await rpc.close();}
});
