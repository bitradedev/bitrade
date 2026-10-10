import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAbiParameters,getEventSelector} from 'viem';
import {QuoteReferences} from '../src/server/adapters/quote-reference.js';
import {LiveGateway} from '../src/server/gateway.js';
import {address,ZERO,FLAP,CHAIN_CONFIG} from '../src/server/adapters/types.js';

const quote=address('0x'+'2'.repeat(40)),other=address('0x'+'4'.repeat(40));
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const rate=(block:number)=>({block,quoteDecimals:18,nativePerQuote:.002});

test('a slow quote currency probe cannot hold 500 receipt callers or invent USD values',async()=>{
 let reads=0,release!:(value:ReturnType<typeof rate>)=>void;
 const refs=new QuoteReferences(async(_quote,block)=>{reads++;return new Promise(r=>release=r);});
 try{for(let i=0;i<500;i++){const result=refs.read(quote,100+i);assert.equal(result.value,undefined);assert.match(result.reason!,/等待后台真实读取/);}assert.equal(reads,1);release(rate(100));await flush();assert.equal(refs.read(quote,599).value?.block,100);}finally{refs.close();}
});

test('references expose actual read identity, cannot use a future block and cannot be mutated by a caller',async()=>{
 let mono=0,wall=500,reads=0;const refs=new QuoteReferences(async(_quote,block)=>{reads++;return rate(block);},()=>mono,()=>wall);
 try{assert.equal(refs.read(quote,100).value,undefined);await flush();const value=refs.read(quote,100).value!;assert.deepEqual(value,{...rate(100),capturedAt:500});value.nativePerQuote=1;
  assert.equal(refs.read(quote,101).value?.nativePerQuote,.002);assert.equal(refs.read(quote,99).value,undefined);await flush();assert.equal(refs.read(quote,100).value?.block,100);assert.equal(reads,2);
 }finally{refs.close();}
});

test('reference expiration and failure cooldown use monotonic time despite wall clock changes',async()=>{
 let mono=0,wall=1000,reads=0;const refs=new QuoteReferences(async(_quote,block)=>{reads++;if(reads>1)throw Error('no route');return rate(block);},()=>mono,()=>wall);
 try{refs.read(quote,100);await flush();mono=14999;wall=-100000;assert(refs.read(quote,101).value);await flush();assert.equal(reads,2);
  mono=15000;wall=99999999;const expired=refs.read(quote,102);assert.equal(expired.value,undefined);assert.match(expired.reason!,/冷却/);assert.equal(reads,2);
  mono=20000;refs.read(quote,103);await flush();assert.equal(reads,3);assert.equal(refs.read(quote,103).value,undefined);
 }finally{refs.close();}
});

test('refreshing a still valid reference keeps its actual captured timestamp until the new read finishes',async()=>{
 let mono=0,reads=0,release!:(value:ReturnType<typeof rate>)=>void;const refs=new QuoteReferences(async(_quote,block)=>{reads++;return reads===1?rate(block):new Promise(r=>release=r);},()=>mono,()=>mono+1000);
 try{refs.read(quote,100);await flush();mono=5000;const old=refs.read(quote,101).value!;assert.equal(old.capturedAt,1000);assert.equal(reads,2);for(let i=0;i<100;i++)assert.equal(refs.read(quote,102).value?.capturedAt,1000);assert.equal(reads,2);
  release(rate(101));await flush();assert.equal(refs.read(quote,102).value?.capturedAt,6000);
 }finally{refs.close();}
});

test('failed routes are retried once after cooldown, without treating a missing stablecoin as one dollar',async()=>{
 let mono=0,reads=0;const refs=new QuoteReferences(async()=>{reads++;throw Error('unsupported quote currency');},()=>mono);
 try{refs.read(quote,100);await flush();for(let i=0;i<500;i++){assert.equal(refs.read(quote,101).value,undefined);assert.match(refs.read(quote,101).reason!,/unsupported quote currency/);}assert.equal(reads,1);
  mono=5000;refs.read(quote,102);await flush();assert.equal(reads,2);
 }finally{refs.close();}
});

test('invalid quote rates, wrong source blocks and missing decimals never become cached prices',async()=>{
 for(const result of [{...rate(100),block:101},{...rate(100),nativePerQuote:NaN},{...rate(100),nativePerQuote:Infinity},{...rate(100),nativePerQuote:0},{...rate(100),quoteDecimals:-1},{...rate(100),quoteDecimals:37},{...rate(100),quoteDecimals:undefined}]){
  const refs=new QuoteReferences(async()=>result as any);try{refs.read(quote,100);await flush();assert.equal(refs.read(quote,100).value,undefined);assert.match(refs.read(quote,100).reason!,/无效/);}finally{refs.close();}
 }
});

test('one background probe serializes a bounded currency queue and newest pending source block wins',async()=>{
 let release!:(value:ReturnType<typeof rate>)=>void;const calls:any[]=[];const refs=new QuoteReferences(async(q,block)=>{calls.push([q,block]);return calls.length===1?new Promise(r=>release=r):rate(block);});
 try{refs.read(quote,100);for(let i=0;i<200;i++)refs.read(address('0x'+(i+100).toString(16).padStart(40,'0')),100);refs.read(other,101);assert.equal(calls.length,1);assert.equal((refs as any).pending.size,32);
  const firstPending=(refs as any).pending.keys().next().value;refs.read(firstPending,105);release(rate(100));await flush();assert.equal(calls.length,33);assert.equal(calls[1][1],105);
 }finally{refs.close();}
});

test('a reorg discards an outstanding old reference; closing prevents any later publication',async()=>{
 let release!:(value:ReturnType<typeof rate>)=>void,reads=0;const refs=new QuoteReferences(async(_quote,block)=>{reads++;return reads===1?new Promise(r=>release=r):rate(block);});
 try{refs.read(quote,100);refs.invalidate();release(rate(100));await flush();assert.equal((refs as any).values.size,0);assert.equal(refs.read(quote,101).value,undefined);await flush();assert.equal(refs.read(quote,101).value?.block,101);
  refs.close();assert.equal(refs.read(quote,102).value,undefined);assert.match(refs.read(quote,102).reason!,/已停止/);assert.equal(reads,2);
 }finally{refs.close();}
});

const tradeFixture=(chain:'bsc'|'robinhood'='bsc')=>{
 const token=address('0x'+'1'.repeat(40)),owner=address('0x'+'3'.repeat(40)),g=new LiveGateway({proxy:''}) as any,events:any[]=[],receipts=new Map<string,any>();
 g.emit=(event:any)=>events.push(event);g.discovered(chain,token,100,0);g.catalog.get(chain+':'+token).decimals=6;g.fx=async()=>({usd:1000,at:Date.now(),mono:performance.now()});
 g.venues[chain].decimals=async(q:string)=>q===token?6:18;g.rpc[chain].block=async(n:number)=>({number:n,hash:hash(n),time:Date.now()});g.rpc[chain].receipt=async(tx:string)=>receipts.get(tx);g.gas[chain].observe=async()=>{};
 const log=(n:number,currency=quote)=>{
  g.routes.set(chain+':'+token,{block:100,route:{kind:'flap',token,quote:currency}});
  const row={address:FLAP,blockHash:hash(100),blockNumber:'0x64',transactionHash:hash(n),logIndex:'0x1',topics:[getEventSelector('TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)')],data:encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[1n,token,owner,2000000n,10000000000000000000n,100000000000000n,1n])};
  const transfer={address:token,topics:[getEventSelector('Transfer(address,address,uint256)'),'0x'+ZERO.slice(2).padStart(64,'0'),'0x'+owner.slice(2).padStart(64,'0')],data:'0x'+(2000000n).toString(16)};
  receipts.set(row.transactionHash,{status:'0x1',from:owner,blockHash:hash(100),blockNumber:'0x64',transactionHash:row.transactionHash,gasUsed:'0x5208',logs:[row,transfer]});return row;
 };
 return {g,events,log,token};
};

test('gateway retains 200 exact unsupported-currency receipts without blocking a native-price trade',async()=>{
 const {g,events,log,token}=tradeFixture();let release!:()=>void,conversionReads=0;
 const gate=new Promise<void>(r=>release=r);g.venues.bsc.conversion=async()=>{conversionReads++;await gate;throw Error('no native route');};
 try{for(let i=1;i<=200;i++)await g.tradeLog('bsc',log(i),false);assert.equal(conversionReads,1);assert.equal(events.length,200);assert(events.every(e=>e.payload.verified&&e.payload.tokenRaw==='2000000'&&e.payload.quoteRaw==='10000000000000000000'&&e.priceUsd===undefined&&e.amountUsd===undefined&&e.payload.conversionError));assert.equal(g.cachedCandles('bsc',token).length,0);
  await g.tradeLog('bsc',log(201,ZERO),false);assert.equal(events[200].priceUsd,5000);assert.equal(events[200].amountUsd,10000);assert.equal(g.cachedCandles('bsc',token).length,1);assert.equal(conversionReads,1);
 }finally{release();await flush();await g.stop();}
});

test('a proved background reference prices only later events and records its exact identity',async()=>{
 const {g,events,log,token}=tradeFixture();let conversionReads=0,spots=0;
 g.venues.bsc.conversion=async()=>{conversionReads++;return {kind:'v2',token:quote,quote:CHAIN_CONFIG.bsc.wrapped};};g.venues.bsc.spot=async()=>{spots++;return .002;};
 try{await g.tradeLog('bsc',log(1),false);assert.equal(events[0].priceUsd,undefined);await flush();await g.tradeLog('bsc',log(2),false);const priced=events[1];assert.equal(priced.priceUsd,10);assert.equal(priced.amountUsd,20);assert.deepEqual({...priced.payload.quoteReference,capturedAt:0},{block:100,quoteDecimals:18,nativePerQuote:.002,capturedAt:0});assert(priced.payload.quoteReference.capturedAt>0);assert.equal(conversionReads,1);assert.equal(spots,1);assert.equal(g.cachedCandles('bsc',token).reduce((sum:number,bar:any)=>sum+bar.volume,0),20);assert.equal(events[0].priceUsd,undefined);
  await g.reorg('bsc',100);assert.equal((g.tradeQuoteReferences.bsc as any).values.size,0);
 }finally{await g.stop();}
});

test('reference storage stays isolated from executable order conversions on both chains',async()=>{
 for(const chain of ['bsc','robinhood'] as const){const {g}=tradeFixture(chain);let reads=0;g.venues[chain].conversion=async(_quote:string,block:number)=>{reads++;return {kind:'v2',token:quote,quote:CHAIN_CONFIG[chain].wrapped,block};};g.venues[chain].spot=async()=>.002;
  try{g.tradeQuoteReferences[chain].read(quote,100);await flush();assert(g.tradeQuoteReferences[chain].read(quote,100).value);assert.equal(reads,1);await g.venues[chain].conversion(quote,101);assert.equal(reads,2);await g.reorg(chain,100);assert.equal(g.tradeQuoteReferences[chain].read(quote,100).value,undefined);await flush();assert.equal(reads,3);}finally{await g.stop();}
 }
});
