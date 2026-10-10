import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionBoard,explainEvent,DecisionJournal} from './explain.mjs';
const now=1791558000000,token='0x'+'1'.repeat(40);
const accounts=[{id:'trial-robinhood-momentum',name:'新盘突破',paused:false,conservativeEquityUsd:100},{id:'trial-robinhood-wallet',name:'钱包首买',paused:false,conservativeEquityUsd:100}];
const market={chain:'robinhood',address:token,symbol:'TEST',name:'Test',platform:'pons-v2',quality:'verified',priceUsd:.00001,updatedAt:now-300000,createdAt:now-120000,reason:'历史参考价'};
const input={chain:'robinhood',now,source:{markets:[market],strategies:[]},sourceAt:now,status:{connected:false,headAt:now-300000},accounts,positions:[],orders:[],counters:{verifiedTrades:0,submitted:0,rejected:0},coverageStart:now-120000,lastReceivedAt:0,trialUntil:now+86400000,checksPassed:true};
test('no trades still shows a factual observation board; stale prices block admission',()=>{
 const b=decisionBoard(input);assert.equal(b.modules.length,6);assert.equal(b.marketCount,1);assert.equal(b.freshMarketCount,0);
 assert.match(b.summary,/过期/);assert.match(b.candidates[0].summary,/链头过期/);
 assert.equal(b.candidates[0].checks.find(c=>c.label==='参考价新鲜度').status,'fail');
 assert.equal(b.candidates[0].checks.find(c=>c.label==='具体金额费用检查').status,'unknown');
 assert.equal(b.modules.find(m=>m.id==='NEWS').status,'未接入');
});
test('catalogue checks cannot claim a qualified signal or completed fee checks',()=>{
 const b=decisionBoard({...input,status:{connected:true,headAt:now},source:{markets:[{...market,updatedAt:now}],strategies:[]}});
 assert.equal(b.freshMarketCount,1);assert.equal(b.candidates[0].stage,'catalog-check');
 assert.equal(b.candidates[0].checks.find(c=>c.label==='连续成交信号').status,'unknown');
 assert.match(b.candidates[0].summary,/等待真实成交/);
});
test('event explanations retain false eligibility, missing data and actual source times',()=>{
 const event={chain:'robinhood',kind:'trade',token,at:now-31000,receivedAt:now,payload:{verified:true}};
 const row=explainEvent({account:{chain:'robinhood',family:'momentum',id:'x'},event,market,now,coverageStart:now-10000,trades:[],wallets:[],result:{eligible:false,reason:'need complete preceding sixty-second trade coverage'}});
 assert.equal(row.outcome,'skip');assert.equal(row.sourceAt,event.at);assert.match(row.summary,/不足60秒/);
 assert.equal(row.checks.find(c=>c.label==='成交量放大').status,'unknown');
 assert.equal(row.checks.find(c=>c.label==='信号有效期').status,'fail');
});
test('decision journals survive reopening, are bounded and isolate chain histories',()=>{
 const meta=new Map(),audit=[];const store={meta:k=>meta.get(k),setMeta:(k,v)=>meta.set(k,structuredClone(v)),audit:(...v)=>audit.push(v)};
 const j=new DecisionJournal(store,3);
 for(let i=0;i<5;i++)j.record({chain:i%2?'bsc':'robinhood',module:'EXEC',at:now+i*61000,summary:'等待 '+i,outcome:'waiting'},0);
 assert.equal(j.rows.length,3);const reopened=new DecisionJournal(store,3);assert.equal(reopened.rows.length,3);
 assert.ok(reopened.recent('robinhood').every(r=>r.chain==='robinhood'));assert.equal(audit.length,5);
});
test('Pons V1 is absent from candidates and counts, while V2 and missing checks remain explicit',()=>{
 const b=decisionBoard({...input,source:{markets:[market,{...market,address:'0x'+'2'.repeat(40),platform:'pons'}],strategies:[]}});
 assert.equal(b.marketCount,1);assert.equal(b.candidates.length,1);assert.equal(b.candidates[0].platform,'pons-v2');
 assert.match(b.modules.find(m=>m.id==='SIZE').summary,/200美元/);
 assert.match(b.modules.find(m=>m.id==='SIZE').summary,/40美元/);
 assert.equal(b.candidates[0].checks.find(c=>c.label==='具体金额费用检查').status,'unknown');
});
test('external candidates show their range and the autonomous $40 allocation',()=>{
 const b=decisionBoard({...input,accounts:accounts.map(a=>({...a,initialCapitalUsd:200,conservativeEquityUsd:200})),source:{markets:[{...market,stage:'dex',platform:'dex',metadata:{route:'v3'},updatedAt:now,createdAt:now-86400000}],strategies:[]},status:{connected:true,headAt:now}});
 assert.equal(b.marketCount,1);assert.equal(b.candidates[0].checks.find(c=>c.label==='入场范围').status,'pass');
 assert.match(b.candidates[0].summary,/外盘候选/);
 assert.equal(b.modules.find(m=>m.id==='SIZE').facts[1].value,40);
});
