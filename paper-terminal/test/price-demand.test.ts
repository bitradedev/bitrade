import test from 'node:test';
import assert from 'node:assert/strict';
import type {Market} from '../src/shared/domain.js';
import {priceRefreshTargets} from '../src/server/price-demand.js';
const market=(id:string,block:number,chain='robinhood',decimals:number|null=18)=>({id:chain+':'+id,address:id,chain,block,decimals} as Market);
test('recent verified trade demand gets a refresh while old catalogue rotation continues',()=>{
 const old=market('old',1),other=market('other',2),traded=market('traded',100);
 assert.deepEqual(priceRefreshTargets([old,other,traded],'robinhood',undefined,new Map([[traded.id,1000]]),2000),[traded,old]);
 assert.deepEqual(priceRefreshTargets([old,other,traded],'robinhood',undefined,new Map([[traded.id,1000]]),17000),[old,other]);
});
test('visible market takes priority, with chain isolation and unknown decimals skipped',()=>{
 const old=market('old',1),visible=market('visible',3),otherChain=market('bsc',0,'bsc'),unknown=market('unknown',0,'robinhood',null);
 assert.deepEqual(priceRefreshTargets([old,visible,otherChain,unknown],'robinhood','visible',new Map(),2000),[visible,old]);
 assert.deepEqual(priceRefreshTargets([old,visible,otherChain],'bsc','visible',new Map(),2000),[otherChain]);
});
test('excluded Robinhood V1 prices do not consume automatic refresh slots; manual viewing remains possible',()=>{
 const v1={...market('v1',0),platform:'pons-v1'},v2={...market('v2',1),platform:'pons-v2'},dex={...market('dex',2),platform:'uniswap-v3'};
 assert.deepEqual(priceRefreshTargets([v1,v2,dex],'robinhood',undefined,new Map(),2000),[v2,dex]);
 assert.deepEqual(priceRefreshTargets([v1,v2,dex],'robinhood','v1',new Map(),2000),[v1,v2]);
});
