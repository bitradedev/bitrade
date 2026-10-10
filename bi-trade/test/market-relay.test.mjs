import test from 'node:test';
import assert from 'node:assert/strict';
import {createRelay} from '../../market-relay/server.mjs';
import {marketFetch} from '../../cloudflare/market-source.mjs';
const TOKEN='0x'+'11'.repeat(20),relayToken='r'.repeat(43),apiKey='test-gmgn-key';
async function fixture(t,fetchImpl){let now=1000000;const server=createRelay({apiKey,relayToken,now:()=>now,fetchImpl});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port;
 return {advance(ms){now+=ms;},async call(path,opts={},auth=true){const r=await fetch(origin+path,{...opts,headers:{...(auth?{Authorization:'Bearer '+relayToken}:{}),...opts.headers}});return {status:r.status,value:await r.json()};}};}
const query='/v1/token/info?chain=bsc&address='+TOKEN+'&timestamp=1000&client_id=old';
test('Read-only relay rejects unauthorized callers, trade routes and non-BSC or injected query parameters',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return Response.json({code:0,data:{}});});
 assert.equal((await f.call('/health',{},false)).value.readOnly,true);
 assert.equal((await f.call(query,{},false)).status,401);
 assert.equal((await f.call('/v1/trade/swap?chain=bsc',{method:'POST'})).status,404);
 assert.equal((await f.call(query.replace('bsc','eth'))).status,400);
 assert.equal((await f.call(query+'&host=evil.example')).status,400);
 assert.equal((await f.call(query+'&address='+TOKEN)).status,400);assert.equal(calls,0);
});
test('Relay uses only its own upstream key, strips caller IP headers and enforces one shared request interval',async t=>{
 const calls=[];const f=await fixture(t,async(url,options)=>{calls.push({url:String(url),options});return Response.json({code:0,data:{address:TOKEN}});});
 assert.equal((await f.call(query,{headers:{'X-APIKEY':'attacker','CF-Connecting-IP':'198.51.100.1','Cookie':'private'}})).status,200);
 assert.equal(calls[0].options.headers['X-APIKEY'],apiKey);assert.equal(calls[0].options.headers['CF-Connecting-IP'],undefined);assert.equal(calls[0].options.headers.Cookie,undefined);
 assert.equal(new URL(calls[0].url).origin,'https://openapi.gmgn.ai');assert.notEqual(new URL(calls[0].url).searchParams.get('client_id'),'old');
 assert.equal((await f.call(query)).status,429);assert.equal(calls.length,1);f.advance(4000);assert.equal((await f.call(query)).status,200);assert.equal(calls.length,2);
});
test('Relay validates discovery batches and rejects redirects and upstream secret echoes',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return calls===1?new Response(null,{status:302,headers:{Location:'https://evil.example'}}):Response.json({key:apiKey});});
 assert.equal((await f.call('/v1/trenches?chain=bsc',{method:'POST',body:JSON.stringify({version:'v2',host:'evil'})})).status,400);assert.equal(calls,0);
 assert.equal((await f.call(query)).status,502);f.advance(4000);const leaked=await f.call(query);assert.equal(leaked.status,502);assert.doesNotMatch(JSON.stringify(leaked.value),/test-gmgn-key/);
});
test('Relay propagates upstream cooldown and refuses repeated API requests during the reset window',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return Response.json({code:429,error:'RATE_LIMIT_BANNED',reset_at:1300},{status:429,headers:{'X-RateLimit-Reset':'1300'}});});
 const blocked=await f.call(query);assert.equal(blocked.status,429);assert.equal(blocked.value.error,'RATE_LIMIT_BANNED');f.advance(4000);assert.equal((await f.call(query)).status,429);assert.equal(calls,1);
});
test('Cloud relay adapter keeps credentials at their authorized destinations and never falls back or changes routes',async()=>{
 const calls=[],mock=async(url,options)=>{calls.push({url:String(url),options});return Response.json({code:0,data:{}});};
 assert.equal(marketFetch({},mock),mock);
 for(const env of [{GMGN_RELAY_URL:'https://market.bitrade.site'},{GMGN_RELAY_TOKEN:relayToken},{GMGN_RELAY_URL:'http://market.bitrade.site',GMGN_RELAY_TOKEN:relayToken}])assert.throws(()=>marketFetch(env,mock));
 const send=marketFetch({GMGN_RELAY_URL:'https://market.bitrade.site',GMGN_RELAY_TOKEN:relayToken},mock);
 await send('https://openapi.gmgn.ai'+query,{method:'GET',headers:{'X-APIKEY':apiKey}});
 assert.equal(new URL(calls[0].url).origin,'https://market.bitrade.site');assert.equal(calls[0].options.headers.Authorization,'Bearer '+relayToken);assert.equal(calls[0].options.headers['X-APIKEY'],undefined);assert.equal(calls[0].options.redirect,'manual');
 for(const path of ['https://evil.example/v1/token/info','https://openapi.gmgn.ai//evil.example','https://openapi.gmgn.ai/v1/trade/swap'])assert.throws(()=>send(path,{method:'GET'}));assert.equal(calls.length,1);
});
