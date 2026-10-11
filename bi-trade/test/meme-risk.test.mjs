import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMemeRisk} from '../lib/meme-risk.mjs';
const TOKEN='0x'+'11'.repeat(20),POOL='0x'+'22'.repeat(20),WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
function evidence(){return {candidate:{category:'meme'},pair:{chainId:'bsc',pairAddress:POOL,baseToken:{address:TOKEN},quoteToken:{address:WBNB},priceUsd:'1',liquidity:{usd:20000},volume:{h24:5000}},proof:{originVerified:true,poolVerified:true,pool:POOL,totalSupply:'1000000',poolBalance:'500000',burnBalance:'0',zeroBalance:'0'},check:{chain:{id:'56'},token:{address:TOKEN,totalHolders:200},pair:{chainId:'56',pair:{address:POOL}},simulationSuccess:true,honeypotResult:{isHoneypot:false},simulationResult:{buyTax:0,sellTax:0,transferTax:0},contractCode:{openSource:true,rootOpenSource:true,isProxy:false,hasProxyCalls:false},summary:{riskLevel:0,flags:[]}},holders:{totalSupply:'1000000',holders:[{address:POOL,balance:'500000',isContract:true},...Array.from({length:50},(_,i)=>({address:'0x'+(i+100).toString(16).padStart(40,'0'),balance:'10000',isContract:false}))]},transferSample:{available:false,fromBlock:null,toBlock:null,clusters:[]}};}
test('independent Meme paper screening keeps missing bundler and native funding evidence unknown',()=>{
 const r=evaluateMemeRisk(TOKEN,evidence(),Date.now());assert.equal(r.buyAllowed,true);assert.equal(r.state,'screened-limited');assert.equal(r.policy,'bsc-meme-paper-v1');
 for(const k of ['bundlerObservedFloatShare','bundlerVolumeShare','ratObservedFloatShare','linkedFunding','blacklist'])assert.equal(r.metrics[k],null);assert.match(r.warnings.join(' '),/未知/);
});
test('wrong identities, missing safety evidence, honeypots, taxes and thin Meme pools cannot pass',()=>{
 for(const mutate of [d=>d.proof.originVerified=false,d=>d.proof.poolVerified=false,d=>d.pair.chainId='ethereum',d=>d.pair.baseToken.address=POOL,d=>d.check.pair.pair.address=TOKEN,d=>d.check.simulationSuccess=false,d=>delete d.check.honeypotResult.isHoneypot,d=>d.check.honeypotResult.isHoneypot=true,d=>delete d.check.simulationResult.sellTax,d=>d.check.simulationResult.buyTax=1,d=>d.check.contractCode.isProxy=true,d=>d.check.summary.riskLevel=30,d=>d.check.summary.flags=[{severityIndex:16}],d=>d.pair.liquidity.usd=9999,d=>d.pair.volume.h24=999,d=>d.check.token.totalHolders=49,d=>d.holders.holders=[],d=>d.holders.totalSupply='999999',d=>delete d.proof.zeroBalance,d=>d.holders.holders.push(d.holders.holders[1])]){const d=evidence();mutate(d);assert.equal(evaluateMemeRisk(TOKEN,d).buyAllowed,false);}
});
test('known concentration and same-transaction distributions block without excluding contract holders',()=>{
 const d=evidence();d.holders.holders[1].balance='150000';d.holders.holders[1].isContract=true;assert.equal(evaluateMemeRisk(TOKEN,d).state,'blocked');
 const linked=evidence();linked.transferSample={available:true,fromBlock:100,toBlock:300,clusters:[{transactionHash:'0x'+'ab'.repeat(32),addresses:linked.holders.holders.slice(1,15).map(h=>h.address)}]};
 const r=evaluateMemeRisk(TOKEN,linked);assert.equal(r.buyAllowed,false);assert.match(r.reasons.join(' '),/同一交易/);assert.equal(r.metrics.bundlerObservedFloatShare,null);
});
