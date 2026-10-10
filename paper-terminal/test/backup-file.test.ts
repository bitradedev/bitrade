import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,createReadStream,readFileSync,statSync,readdirSync} from 'node:fs';import {resolve} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {Readable} from 'node:stream';
import {Store} from '../src/server/store.js';import {Engine} from '../src/server/engine.js';import {makeServer} from '../src/server/server.js';import type {MarketGateway} from '../src/shared/domain.js';

test('streamed backup and binary restore support history larger than the old 50MB limit',async()=>{
 const root=resolve('data/test-runs');mkdirSync(root,{recursive:true});const store=new Store(mkdtempSync(resolve(root,'large-backup-')));
 const gateway={statuses:()=>[],markets:()=>[],getMarket:()=>undefined,setWallets:()=>{}} as unknown as MarketGateway;const engine=new Engine(store,gateway),port=8796,server=makeServer(engine,resolve('dist/web'),port);
 try{
  store.setMeta('snapshot-marker','before');store.db.exec('CREATE TABLE large_history(payload BLOB); INSERT INTO large_history VALUES(zeroblob(57671680))');let timerTicks=0;const timer=setInterval(()=>timerTicks++,1);let file:string;
  try{file=await store.backupFile();}finally{clearInterval(timer);}
  assert.equal(store.activeBackups,0);assert.ok(statSync(file!).size>50*1024*1024);assert.ok(timerTicks>0,'native backup must yield to the event loop');
  const exported=new DatabaseSync(file!,{readOnly:true});try{assert.equal(exported.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(exported.prepare('SELECT length(payload) AS n FROM large_history').get()!.n,57671680);}finally{exported.close();}
  store.setMeta('snapshot-marker','after');await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});const url=`http://127.0.0.1:${port}`;
  const unauthorized=await fetch(url+'/api/restore',{method:'POST',headers:{'content-type':'application/vnd.sqlite3'},body:new Uint8Array(100)});assert.equal(unauthorized.status,403);assert.equal(store.meta('snapshot-marker'),'after');
  const upload=Readable.toWeb(createReadStream(file!));const response=await fetch(url+'/api/restore',{method:'POST',headers:{'content-type':'application/vnd.sqlite3','x-csrf-token':engine.csrf,'content-length':String(statSync(file!).size)},body:upload as any,duplex:'half'} as any);
  assert.equal(response.status,200,await response.text());assert.equal(store.meta('snapshot-marker'),'before');assert.equal(engine.broker.checks().passed,true);assert.ok(engine.broker.strategies().every(s=>s.state==='paused'));
  assert.ok(readdirSync(store.dataDir).some(n=>n.includes('.before-restore-')));assert.equal(readdirSync(store.dataDir).some(n=>/^restore-.*\.sqlite$/.test(n)),false);
  const bad=await fetch(url+'/api/restore',{method:'POST',headers:{'content-type':'application/vnd.sqlite3','x-csrf-token':engine.csrf},body:new Uint8Array(100)});assert.equal(bad.status,400);assert.equal(store.meta('snapshot-marker'),'before');assert.equal(readdirSync(store.dataDir).some(n=>/^restore-.*\.sqlite$/.test(n)),false);
  const download=await fetch(url+'/api/backup',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':engine.csrf},body:'{}'});assert.equal(download.status,200);let bytes=0,header=Buffer.alloc(0);for await(const chunk of download.body as any){if(header.length<16)header=Buffer.concat([header,Buffer.from(chunk)]).subarray(0,16);bytes+=chunk.length;}assert.equal(header.toString(),'SQLite format 3\0');assert.ok(bytes>50*1024*1024);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
