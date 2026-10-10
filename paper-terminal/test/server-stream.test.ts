import test from 'node:test';
import assert from 'node:assert/strict';
import {get,type IncomingMessage} from 'node:http';
import {createServer as createPortProbe} from 'node:net';
import {resolve} from 'node:path';
import {makeServer} from '../src/server/server.js';
import type {Engine} from '../src/server/engine.js';
import {StateStreamReceiver} from '../src/shared/state-stream.js';
import type {AppState} from '../src/shared/domain.js';

async function unusedLocalPort(){const probe=createPortProbe();await new Promise<void>((accept,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',accept);});const address=probe.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>((accept,reject)=>probe.close(error=>error?reject(error):accept()));return port;}

test('large live-state packets survive backpressure on the same SSE connection',async()=>{
 const port=await unusedLocalPort();let changed=()=>{};let revision=0;
 const engine={csrf:'isolated-stream-test',setChanged:(fn:()=>void)=>{changed=fn;},state:()=>({mode:'paper',revision,markets:[{notes:'行情'.repeat(200000)}]})} as unknown as Engine;
 const server=makeServer(engine,resolve('dist/web'),port);let stream:IncomingMessage|undefined;
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
  stream=await new Promise<IncomingMessage>((accept,reject)=>{get(`http://127.0.0.1:${port}/api/events`,accept).once('error',reject);});
  assert.equal(stream.statusCode,200);let text='';let ended=false;stream.setEncoding('utf8');stream.on('data',chunk=>{text+=chunk;});stream.on('end',()=>{ended=true;});
  const waitFor=async(predicate:()=>boolean)=>{const deadline=Date.now()+7000;while(!predicate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(predicate(),'SSE did not deliver a complete current state');};
  await waitFor(()=>text.includes('"revision":0')&&text.endsWith('\n\n'));
  stream.pause();revision=1;changed();await new Promise(r=>setTimeout(r,2200));revision=2;changed();stream.resume();
  await waitFor(()=>text.includes('"revision":2')&&text.endsWith('\n\n'));
  assert.equal(ended,false,'backpressure must not terminate the live connection');
 }finally{stream?.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('opt-in deltas mirror independent subscribers through updates, removals, backpressure and reconnect',async()=>{
 const port=await unusedLocalPort();let changed=()=>{},version=0;
 const base={mode:'paper',csrf:'delta-isolated',at:1000,chains:[{chain:'bsc',head:100,connected:true}],markets:Array.from({length:300},(_,i)=>({id:'m'+i,priceUsd:1,notes:'真实数据'.repeat(80)})),accounts:[{id:'a',nativeBalanceRaw:'900719925474099312345'}],positions:[{id:'p',remainingRaw:'10000'}],orders:[{id:'o',status:'queued'}],fills:[],strategies:[],researchRuns:[],audit:[],risk:{riskPct:.5},health:{ledger:{passed:true},unchanged:'证据'}} as unknown as AppState;
 const engine={csrf:'isolated-stream-test',setChanged:(fn:()=>void)=>{changed=fn;},state:()=>{const next=structuredClone(base);next.at=1000+version;next.markets[0].priceUsd=version+1;if(version>=2){next.positions=[];next.orders[0].status='failed';next.orders[0].error='重组，拒绝成交';next.fills=[{id:'f',tokenRaw:'900719925474099399999'} as any];next.markets[0].metadata={notes:'大历史回补'.repeat(100000)};}return next;}} as unknown as Engine;
 const server=makeServer(engine,resolve('dist/web'),port),streams:IncomingMessage[]=[];
 const attach=async()=>{const stream=await new Promise<IncomingMessage>((accept,reject)=>get(`http://127.0.0.1:${port}/api/events?delta=1`,accept).once('error',reject));streams.push(stream);stream.setEncoding('utf8');let buffer='';const packets:any[]=[],states:AppState[]=[],errors:unknown[]=[],receiver=new StateStreamReceiver();stream.on('data',chunk=>{buffer+=chunk;let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!frame.startsWith('data: '))continue;try{const packet=JSON.parse(frame.slice(6));packets.push(packet);states.push(receiver.accept(packet));}catch(e){errors.push(e);}}});return {stream,packets,states,errors};};
 const wait=async(predicate:()=>boolean)=>{const end=performance.now()+5000;while(!predicate()&&performance.now()<end)await new Promise(r=>setTimeout(r,15));assert.ok(predicate(),'incremental stream did not deliver current state');};
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});const a=await attach(),b=await attach();await wait(()=>a.states.length>=1&&b.states.length>=1);
  assert.notEqual(a.packets[0].streamId,b.packets[0].streamId);assert.equal(a.packets[0].type,'state-snapshot');
  version=1;changed();await wait(()=>a.states.at(-1)?.markets[0].priceUsd===2&&b.states.at(-1)?.markets[0].priceUsd===2);
  assert.equal(a.packets[1].type,'state-delta');assert.ok(JSON.stringify(a.packets[1]).length<JSON.stringify(a.packets[0]).length*.05);
  a.stream.pause();version=2;changed();await wait(()=>b.states.at(-1)?.fills.length===1);version=3;changed();a.stream.resume();
  await wait(()=>a.states.at(-1)?.markets[0].priceUsd===4&&b.states.at(-1)?.markets[0].priceUsd===4);
  for(const subscriber of [a,b]){assert.deepEqual(subscriber.errors,[]);assert.equal(subscriber.states.at(-1)?.positions.length,0);assert.equal(subscriber.states.at(-1)?.orders[0].error,'重组，拒绝成交');assert.equal(subscriber.states.at(-1)?.fills[0].tokenRaw,'900719925474099399999');}
  const fresh=await attach();await wait(()=>fresh.states.length>=1);assert.equal(fresh.packets[0].type,'state-snapshot');assert.equal(fresh.packets[0].revision,0);assert.notEqual(fresh.packets[0].streamId,a.packets[0].streamId);assert.equal(fresh.states[0].markets[0].priceUsd,4);
 }finally{for(const stream of streams)stream.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('a later incremental subscriber preempts the queued legacy deadline while legacy stays throttled',async()=>{
 const port=await unusedLocalPort();let changed=()=>{},version=0;const engine={csrf:'mixed-timing',setChanged:(fn:()=>void)=>{changed=fn;},state:()=>({mode:'paper',at:Date.now(),csrf:'mixed-timing',revision:version,markets:[{id:'m',priceUsd:version}]})} as unknown as Engine;
 const server=makeServer(engine,resolve('dist/web'),port),streams:IncomingMessage[]=[];
 const attach=async(delta:boolean)=>{const stream=await new Promise<IncomingMessage>((accept,reject)=>get(`http://127.0.0.1:${port}/api/events${delta?'?delta=1':''}`,accept).once('error',reject));streams.push(stream);stream.setEncoding('utf8');let buffer='';const states:{state:any;at:number}[]=[],receiver=new StateStreamReceiver();stream.on('data',chunk=>{buffer+=chunk;let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith('data: '))states.push({state:receiver.accept(JSON.parse(frame.slice(6))),at:performance.now()});}});return states;};
 const wait=async(predicate:()=>boolean)=>{const end=performance.now()+4000;while(!predicate()&&performance.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());};
 try{
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});const legacy=await attach(false);await wait(()=>legacy.length>=1);version=1;changed();await new Promise(r=>setTimeout(r,500));const delta=await attach(true);await wait(()=>delta.length>=1);const begun=delta[0].at;version=2;changed();
  await wait(()=>delta.some(row=>row.state.revision===2));const arrived=delta.find(row=>row.state.revision===2)!;assert.ok(arrived.at-begun<1400,`incremental frame waited ${arrived.at-begun}ms for legacy schedule`);assert.equal(legacy.length,1);
  await wait(()=>legacy.some(row=>row.state.revision===2));assert.ok(legacy.at(-1)!.at-legacy[0].at>=1900);
 }finally{for(const stream of streams)stream.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
