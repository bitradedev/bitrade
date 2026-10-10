import test from 'node:test';
import assert from 'node:assert/strict';
import {gmgnProxy,GmgnReadQueue} from '../src/server/adapters/gmgn.js';
import {LiveGateway} from '../src/server/gateway.js';
test('market collection and risk queue honor the same proxy override and explicit direct mode',()=>{
 const previous=process.env.PAPER_PROXY;
 try{
  process.env.PAPER_PROXY='http://127.0.0.1:8123';
  assert.equal(gmgnProxy(),process.env.PAPER_PROXY);
  assert.equal((new GmgnReadQueue() as any).proxy,process.env.PAPER_PROXY);
  const g=new LiveGateway({proxy:'direct'}) as any;
  assert.equal(g.proxy,'');assert.equal(g.gmgn.proxy,'');g.stop();
  assert.equal(gmgnProxy(' direct '),'');assert.equal(gmgnProxy(''),'');
 }finally{if(previous===undefined)delete process.env.PAPER_PROXY;else process.env.PAPER_PROXY=previous;}
});
