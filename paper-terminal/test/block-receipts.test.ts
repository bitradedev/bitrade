import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadRpc,assertReadOnly} from '../src/server/adapters/rpc.js';

const tx=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const hash=tx(1000);
const row=(n:number,block=100)=>({transactionHash:tx(n),blockNumber:'0x'+block.toString(16),blockHash:hash,status:'0x1',from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40),gasUsed:'0x5208',logs:[]});
const rpcFor=(chain:'bsc'|'robinhood',read:(method:string,params:any[])=>Promise<any>)=>{const rpc=new ReadRpc(chain,'') as any;rpc.verify=async()=>{};rpc.request=read;return rpc as ReadRpc;};

test('a real block receipt batch serves a busy launch without one RPC per trade',async()=>{
 let requests=0,release!:(rows:any[])=>void;
 const rpc=rpcFor('bsc',async(method,params)=>{assert.equal(method,'eth_getBlockReceipts');assert.deepEqual(params,['0x64']);requests++;return new Promise(r=>release=r);});
 try{const reads=Array.from({length:200},(_,i)=>rpc.receipt(tx(i+1),100));await Promise.resolve();assert.equal(requests,1);release(Array.from({length:200},(_,i)=>row(i+1)));const results=await Promise.all(reads);assert.deepEqual(results.map(r=>r?.transactionHash),Array.from({length:200},(_,i)=>tx(i+1)));assert.equal(requests,1);}finally{await rpc.close();}
});

test('unsupported batch reads fall back to exact transaction receipts and cool down',async()=>{
 const calls:string[]=[],rpc=rpcFor('bsc',async(method,params)=>{calls.push(method);if(method==='eth_getBlockReceipts')throw Error('method not found');return row(Number(BigInt(params[0])));});
 try{assert.equal((await rpc.receipt(tx(1),100))?.transactionHash,tx(1));assert.equal((await rpc.receipt(tx(2),101))?.transactionHash,tx(2));assert.deepEqual(calls,['eth_getBlockReceipts','eth_getTransactionReceipt','eth_getTransactionReceipt']);}finally{await rpc.close();}
});

test('malformed, wrong-block, mixed-fork and duplicate batches cannot prove a trade',async()=>{
 for(const batch of [null,[row(1,99)],[row(1),{...row(2),blockHash:tx(2000)}],[row(1),row(1)],[{...row(1),transactionHash:'fake'}],[{...row(1),logs:null}]]){
  const calls:string[]=[],rpc=rpcFor('bsc',async method=>{calls.push(method);return method==='eth_getBlockReceipts'?batch:null;});
  try{assert.equal(await rpc.receipt(tx(1),100),null);assert.deepEqual(calls,['eth_getBlockReceipts','eth_getTransactionReceipt']);}finally{await rpc.close();}
 }
});

test('a missing transaction in a block response still requires its individual receipt',async()=>{
 const calls:string[]=[],rpc=rpcFor('bsc',async method=>{calls.push(method);return method==='eth_getBlockReceipts'?[row(2)]:null;});
 try{assert.equal(await rpc.receipt(tx(1),100),null);assert.deepEqual(calls,['eth_getBlockReceipts','eth_getTransactionReceipt']);}finally{await rpc.close();}
});

test('reorg cache invalidation rejects an in-flight old batch and requests the new fork',async()=>{
 let release!:(rows:any[])=>void,reads=0;const rpc=rpcFor('bsc',async method=>{assert.equal(method,'eth_getBlockReceipts');reads++;return reads===1?new Promise(r=>release=r):[{...row(1),blockHash:tx(2000)}];});
 try{const pending=rpc.receipt(tx(1),100);await Promise.resolve();rpc.clearCache();release([row(1)]);await assert.rejects(pending,/缓存失效/);assert.equal((await rpc.receipt(tx(1),100))?.blockHash,tx(2000));assert.equal(reads,2);}finally{await rpc.close();}
});

test('Robinhood and blockless reads retain the exact existing receipt path',async()=>{
 for(const chain of ['bsc','robinhood'] as const){const calls:string[]=[],rpc=rpcFor(chain,async method=>{calls.push(method);return row(1);});try{await rpc.receipt(tx(1),chain==='robinhood'?100:undefined);assert.deepEqual(calls,['eth_getTransactionReceipt']);}finally{await rpc.close();}}
 assert.doesNotThrow(()=>assertReadOnly('eth_getBlockReceipts'));for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign'])assert.throws(()=>assertReadOnly(method),/只读/);
});

test('a queued proof cannot inherit an expired scanner or previous proof deadline',async()=>{
 const rpc=new ReadRpc('bsc','') as any;
 try{await rpc.priorityContext.run({priority:'foreground',deadline:performance.now()-1000},()=>rpc.withProofBudget(async()=>{const context=rpc.priorityContext.getStore();assert.equal(context.priority,'foreground');assert(context.deadline>performance.now()+4000);},false));
  await rpc.priorityContext.run({priority:'foreground',deadline:performance.now()-1000},()=>rpc.withProofBudget(async()=>{const context=rpc.priorityContext.getStore();assert.equal(context.priority,'background');assert(context.deadline>performance.now()+4000);},true));
 }finally{await rpc.close();}
});

test('ordinary nested quotes still inherit their parent deadline and cannot silently extend it',async()=>{
 const rpc=new ReadRpc('bsc','') as any,deadline=performance.now()+500;
 try{await rpc.priorityContext.run({priority:'foreground',deadline},()=>rpc.withPriority(async()=>assert.equal(rpc.priorityContext.getStore().deadline,deadline)));}finally{await rpc.close();}
});
