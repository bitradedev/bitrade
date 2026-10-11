import test from 'node:test';
import assert from 'node:assert/strict';
import {IOBudget} from '../io-budget.mjs';
import {PublicBscData} from '../public-data.mjs';
test('Per-invocation network budget counts actual requests, isolates concurrent events and renews on the next round',async()=>{
 let calls=0;const io=new IOBudget(2,async()=>{calls++;return Response.json({});});
 await Promise.all([io.run('alarm',async()=>{assert.equal(io.remaining,2);await io.fetch('https://a.example');assert.equal(io.remaining,1);await Promise.resolve();await io.fetch('https://a.example');assert.equal(io.exhausted,false);assert.throws(()=>io.fetch('https://a.example'),e=>e.code==='CF_SUBREQUEST_BUDGET');assert.equal(io.exhausted,true);assert.equal(io.remaining,0);}),io.run('http',()=>io.fetch('https://a.example'))]);
 assert.equal(calls,3);assert.equal(io.lastAlarm.used,2);await io.run('alarm',()=>io.fetch('https://a.example'));assert.equal(calls,4);assert.equal(io.lastAlarm.used,1);
});
test('Local invocation exhaustion does not ban or cool down a healthy public provider',async()=>{
 const rows=new Map(),store={get:(k,id)=>rows.get(k+id)??null,put:(k,v)=>{rows.set(k+v.id,v);return v;}},io=new IOBudget(1,async()=>Response.json({pairs:[]})),source=new PublicBscData(store,{}, {fetchImpl:io.fetch,now:()=>1000000});
 await io.run('alarm',async()=>{await io.fetch('https://a.example');await assert.rejects(source.read('dex','/test'),e=>e.code==='CF_SUBREQUEST_BUDGET');});
 assert.equal(source.status()[0].limited,false);await io.run('alarm',()=>source.read('dex','/test'));assert.equal(source.status()[0].lastSuccessAt,1000000);
});
