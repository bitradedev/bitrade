import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {encodeAbiParameters,encodeEventTopics} from 'viem';
const require=createRequire(realpathSync('node_modules/wrangler/package.json'));
await require('esbuild').build({entryPoints:['cloudflare/builtin-entry-evidence.mjs'],bundle:true,platform:'node',format:'esm',outfile:'.cloud-test-build/entry-evidence-test.mjs'});
const {BuiltinEntryEvidence,turnoverRows,narrativeSources,SWAPS}=await import('../../.cloud-test-build/entry-evidence-test.mjs');
const token='0x'+'11'.repeat(20),pool='0x'+'22'.repeat(20),other='0x'+'33'.repeat(20),hash='0x'+'aa'.repeat(32),tx='0x'+'bb'.repeat(32);
const portal='0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
const {parseAbi}=await import('viem');
const flap=parseAbi(['event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)']);
function log(abi,args,block=1000,i=0,address=pool){const event=abi[0];return{address,blockNumber:'0x'+block.toString(16),logIndex:'0x'+i.toString(16),blockHash:hash,transactionHash:tx,topics:encodeEventTopics({abi,eventName:event.name,args}),data:encodeAbiParameters(event.inputs.filter(x=>!x.indexed),event.inputs.filter(x=>!x.indexed).map(x=>args[x.name]))};}
function fixture(kind='flap'){
 let now=1800000000000,reorg=false,requests=0;
 const map=new Map(),store={get:(k,id)=>map.get(k+id),put:(k,v)=>map.set(k+v.id,structuredClone(v))};
 const route={kind,token,quote:other,pool};
 const logs=kind==='flap'?[log(flap,{ts:BigInt(now/1000-299),token,buyer:other,amount:1n,eth:2000000000n,fee:0n,postPrice:1n},1402,0,portal),log(flap,{ts:BigInt(now/1000-10),token,buyer:other,amount:1n,eth:1500000000n,fee:0n,postPrice:1n},1980,1,portal)]:[];
 const rpc={block:async(n=2004,force=false)=>({number:n,time:1800000000000-(2000-n)*500,hash:reorg&&force?'0x'+'cc'.repeat(32):hash}),request:async(_m,[p])=>{requests++;return logs.filter(l=>Number(BigInt(l.blockNumber))>=Number(BigInt(p.fromBlock))&&Number(BigInt(l.blockNumber))<=Number(BigInt(p.toBlock)));}};
 const market={rpc,head:{head:2004},route:async()=>route,getMarket:()=>({quality:'verified',quoteUsd:1,updatedAt:now}),venues:{bsc:{decimals:async()=>6,poolToken0:async()=>token}}};
 return {engine:new BuiltinEntryEvidence(store,market,{now:()=>now}),store,market,advance:n=>now+=n,reorg:()=>reorg=true,requests:()=>requests};
}
test('five minutes is timestamp-based at fast BSC blocks; shared Portal logs convert actual quote decimals and evict expired trades without renewing sample age',async()=>{
 const f=fixture(),first=await f.engine.volume(token);assert.equal(first.usd,3500);assert.equal(first.fromBlock,1400);assert.equal(first.quoteDecimals,6);assert.equal(first.toTime,1800000000000);assert.equal(f.requests(),1);
 f.advance(2000);const next=await f.engine.volume(token);assert.equal(next.usd,1500);assert.equal(next.at,first.at);assert.equal(next.fromBlock,1404);assert.equal(f.requests(),1);
 f.reorg();await assert.rejects(f.engine.volume(token),/重组/);
});
test('pool V2 and Pancake V3 swaps count one quote side, both directions, and reject duplicates or wrong emitters',()=>{
 const v2={kind:'v2',token,quote:other,pool};
 const a=log([SWAPS[0]],{sender:other,to:other,amount0In:0n,amount1In:3000n,amount0Out:10n,amount1Out:0n});
 assert.equal(turnoverRows([a],v2,900,1100,token)[0].quoteRaw,'3000');
 assert.throws(()=>turnoverRows([a,a],v2,900,1100,token),/重复/);
 assert.throws(()=>turnoverRows([{...a,address:other}],v2,900,1100,token),/身份/);
 const b=log([SWAPS[1]],{sender:other,recipient:other,amount0:10n,amount1:-4000n,sqrtPriceX96:1n,liquidity:1n,tick:0,protocolFeesToken0:0n,protocolFeesToken1:0n});
 assert.deepEqual(turnoverRows([b],{...v2,kind:'v3'},900,1100,token).map(x=>[x.quoteRaw,x.buy]),[['4000',false]]);
});
test('narrative collector treats links as unverified self-report, limits text and never follows supplied links',()=>{
 const rows=narrativeSources({description:'d'.repeat(3000),twitter:'https://x.com/example',website:'http://127.0.0.1/admin',telegram:'https://localhost/secret'},'ipfs:test',1);
 assert.equal(rows.length,2);assert.equal(rows[0].text.length,1600);assert.ok(rows.every(x=>x.independent===false));assert.equal(rows[1].kind,'project-link-unverified');
});
test('source failure and unsupported routes remain unknown, never fabricate 3000 volume or fetching arbitrary metadata URLs',async()=>{
 const f=fixture('four');const row=await f.engine.collect(token);assert.equal(row.volume5m,null);assert.equal(row.eligibility.allowed,false);assert.equal(row.narrative.state,'unknown');await assert.rejects(f.engine.assert(token),/尚未核实/);
});

test('Flap narrative reads only the documented fixed gateway and marks description as self-report; arbitrary URI and overlarge body stay unknown',async()=>{
 const f=fixture(),uri='bafkreieepx7lh6zcpqsneo2jdeqmcgxjg7facam34w5ezh4myajjauuc24';let requests=0,cid=uri,large=false;
 f.market.rpc.read=async()=>cid;
 f.market.memeData={flap:{supports:()=>true},fetch:async(url,opts)=>{requests++;assert.equal(url,'https://flap.mypinata.cloud/ipfs/'+uri);assert.equal(opts.redirect,'manual');return new Response(JSON.stringify({description:large?'x'.repeat(40000):'Project story',twitter:'https://x.com/project'}),{headers:{'Content-Type':'application/json'}});}};
 const n=await f.engine.narrative(token);assert.equal(n.state,'project-material-only');assert.equal(n.sources[0].text,'Project story');assert.ok(n.sources.every(s=>s.independent===false));assert.equal(requests,1);
 cid='https://127.0.0.1/secret';assert.equal((await f.engine.narrative(other)).state,'unknown');assert.equal(requests,1);
 cid=uri;large=true;assert.equal((await f.engine.narrative(pool)).state,'unknown');assert.equal(requests,2);
});
