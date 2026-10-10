import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGateway} from '../src/server/gateway.js';
import {assessScanFreshness} from '../src/server/market-coverage.js';
import {address,ZERO,FLAP,FOUR_MANAGER} from '../src/server/adapters/types.js';

test('BSC scans every one of 19 pools in accepted groups, keeping the full block window',async()=>{
 const g=new LiveGateway({proxy:''}) as any,requests:any[]=[];let release!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),pools=Array.from({length:19},(_,n)=>address('0x'+(n+100).toString(16).padStart(40,'0')));
 for(let n=0;n<19;n++){const token=address('0x'+(n+200).toString(16).padStart(40,'0'));g.routes.set('bsc:'+token,{block:1,route:{kind:'v2',token,quote:ZERO,pool:pools[n]}});}
 g.rpc.bsc.logs=async(filter:any)=>{requests.push(filter);assert(filter.address.length<=8);await gate;return [];};
 const scan=g.scanLogs('bsc',100,115,true);
 try{assert.equal(requests.length,4);assert.deepEqual(requests[0].address,[FLAP,FOUR_MANAGER]);assert.deepEqual(requests.slice(1).map(row=>row.address.length),[8,8,3]);assert.deepEqual([...new Set(requests.slice(1).flatMap(row=>row.address))].sort(),pools.sort());assert(requests.every(row=>row.fromBlock==='0x64'&&row.toBlock==='0x73'));release();await scan;}finally{release();await g.stop();}
});

test('scan rejection keeps its cursor and diagnostic through fresh WS heads; success clears only after all reads',async()=>{
 const audit:any[]=[],g=new LiveGateway({proxy:'',onAudit:(...row)=>audit.push(row)}) as any;
 g.running=true;g.persist=async()=>{};g.scanHead.bsc=100;g.rawHeads.bsc={number:101,hash:'hash',time:Date.now()};g.scan=async()=>{throw Error('Request blocked');};
 try{await g.poll('bsc');assert.equal(g.scanHead.bsc,100);assert.equal(audit.length,1);assert.equal(audit[0][1],'行情扫描读取失败');assert.equal(audit[0][2].from,99);assert.equal(audit[0][2].to,101);
  g.head('bsc',102,Date.now());const row=g.statuses().find((s:any)=>s.chain==='bsc');assert.equal(row.connected,true);assert.equal(row.lastScanError,'Request blocked');assert.equal(row.scanHead,100);assert.equal(row.scanLagBlocks,2);assert.equal(assessScanFreshness([row])[0].current,false);
  await g.poll('bsc');assert.equal(audit.length,1);
  let release!:()=>void;g.scan=async()=>new Promise<void>(resolve=>release=resolve);const pending=g.poll('bsc');assert.equal(g.scanHead.bsc,100);assert.equal(g.scanErrors.bsc,'Request blocked');release();await pending;assert.equal(g.scanHead.bsc,101);assert.equal(g.scanErrors.bsc,'');
 }finally{await g.stop();}
});

test('failure of any pool group cannot make a successful factory read advance the complete cursor',async()=>{
 const g=new LiveGateway({proxy:''}) as any;g.running=true;g.persist=async()=>{};g.scanHead.bsc=100;g.rawHeads.bsc={number:101,hash:'hash',time:Date.now()};g.rpc.bsc.withPriority=async(fn:any)=>fn();
 const pools=Array.from({length:19},(_,n)=>address('0x'+(n+100).toString(16).padStart(40,'0')));for(let n=0;n<19;n++){const token=address('0x'+(n+200).toString(16).padStart(40,'0'));g.routes.set('bsc:'+token,{block:1,route:{kind:'v2',token,quote:ZERO,pool:pools[n]}});}
 let calls=0;g.rpc.bsc.logs=async(filter:any)=>{calls++;if(filter.address.length===3)throw Error('read failed');return [];};
 try{await g.poll('bsc');assert.equal(calls,4);assert.equal(g.scanHead.bsc,100);assert.equal(g.scanErrors.bsc,'read failed');}finally{await g.stop();}
});

test('acceptance needs independently current scanner progress, not just fresh chain heads',()=>{
 const chains=[{chain:'bsc',head:1000,scanHead:999,lastScanError:''},{chain:'robinhood',head:2000,scanHead:1999,lastScanError:''}];assert(assessScanFreshness(chains).every(row=>row.current));
 assert.equal(assessScanFreshness([{...chains[0],lastScanError:'limit exceeded'}])[0].current,false);assert.equal(assessScanFreshness([{...chains[0],scanHead:935}])[0].current,false);assert.equal(assessScanFreshness([{...chains[1],scanHead:1743}])[0].current,false);
 assert.equal(assessScanFreshness([{...chains[0],scanHead:1001}])[0].current,false);assert.equal(assessScanFreshness([{chain:'bsc',head:1000}])[0].current,false);assert.equal(assessScanFreshness([{...chains[0],scanHead:936}])[0].current,true);assert.equal(assessScanFreshness([{...chains[1],scanHead:1744}])[0].current,true);
 assert.equal(assessScanFreshness([{...chains[0],head:NaN}])[0].current,false);assert.equal(assessScanFreshness([{...chains[0],chain:'unsupported'}])[0].current,false);
});
