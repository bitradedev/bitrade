import test from 'node:test';import assert from 'node:assert/strict';import {get,type IncomingMessage} from 'node:http';import {resolve} from 'node:path';
import {makeServer} from '../src/server/server.js';import type {Engine} from '../src/server/engine.js';import type {Candle} from '../src/shared/domain.js';

test('chart stream pushes actual cached bar updates and full backfills without rebuilding app state',async()=>{
 const port=8795,token='0x1111111111111111111111111111111111111111';let bars:Candle[]=[{time:60,open:1,high:1,low:1,close:1,volume:1}],historyAt=1,stateReads=0;
 const engine={csrf:'isolated-candles',setChanged:()=>{},state:()=>{stateReads++;return {};},gateway:{candles:async()=>bars,cachedCandles:()=>bars.map(b=>({...b})),candleStatus:()=>({source:'verified-local',pending:false,reason:'isolated actual cached fixture',state:'ready',rows:bars.length,historyAt})}} as unknown as Engine;
 const server=makeServer(engine,resolve('dist/web'),port);let stream:IncomingMessage|undefined;
 try{await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});stream=await new Promise<IncomingMessage>((accept,reject)=>get(`http://127.0.0.1:${port}/api/candles/events?chain=bsc&token=${token}`,accept).once('error',reject));assert.equal(stream.statusCode,200);stream.setEncoding('utf8');let buffer='';const packets:any[]=[];stream.on('data',chunk=>{buffer+=chunk;let end:number;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith('data: '))packets.push(JSON.parse(frame.slice(6)));}});
  const wait=async(count:number)=>{const until=Date.now()+2000;while(packets.length<count&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.equal(packets.length,count);};await wait(1);assert.equal(packets[0].full,true);assert.equal(packets[0].candles[0].close,1);
  bars[0]={...bars[0],high:2,close:2,volume:3};await wait(2);assert.equal(packets[1].full,false);assert.equal(packets[1].candles[0].close,2);
  bars.push({time:90,open:2,high:3,low:2,close:3,volume:4});await wait(3);assert.equal(packets[2].full,false);assert.equal(packets[2].candles.at(-1).time,90);
  bars.unshift({time:30,open:1,high:1,low:1,close:1,volume:2});historyAt=2;await wait(4);assert.equal(packets[3].full,true);assert.equal(packets[3].candles.length,3);assert.equal(stateReads,0);
 }finally{stream?.destroy();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
