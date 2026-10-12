import test from 'node:test';
import assert from 'node:assert/strict';
import {showcasePositions} from '../lib/showcase-exits.mjs';

const token='0x'+'11'.repeat(20);
const first={id:'old-lot',agentId:'showcase-trend',orderId:'old-entry',token,remainingRaw:'40',usdCost:4,at:1000,symbol:'TEST'};
const second={...first,id:'new-lot',orderId:'new-entry',remainingRaw:'60',usdCost:6,at:2000};
const oldRule={id:'old-entry',policyVersion:2,takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60,internalSecret:'must-not-appear'};
const newRule={id:'new-entry',policyVersion:2,takeProfitPct:30,stopLossPct:15,maxHoldMinutes:1440};
const store=records=>({get:(_table,id)=>records[id]??null});

test('grouped exit plans use the oldest remaining entry and total remaining cost, including additions',()=>{
 const s=store({'old-entry':oldRule,'new-entry':newRule});
 const [p]=showcasePositions(s,[second,first]);
 assert.equal(p.amountRaw,'100');assert.equal(p.costUsd,10);
 assert.deepEqual(p.exitPlan.rule,{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 assert.equal(p.exitPlan.entryOrderId,'old-entry');assert.equal(p.exitPlan.openedAt,1000);assert.equal(p.exitPlan.deadlineAt,3601000);
 assert.equal(p.exitPlan.scope,'entire-token-position');assert.equal(p.exitPlan.basis,'net-executable-usd-return');
 assert.doesNotMatch(JSON.stringify(p),/internalSecret|must-not-appear/);
 const next=showcasePositions(s,[{...first,remainingRaw:'0'},second])[0];
 assert.deepEqual(next.exitPlan.rule,{takeProfitPct:30,stopLossPct:15,maxHoldMinutes:1440});assert.equal(next.costUsd,6);
 assert.deepEqual(showcasePositions(s,[]),[]);
});

test('legacy frozen thresholds remain historical context and explicit AI updates govern only their own entry',()=>{
 const legacy={...oldRule,policyVersion:1}, records={'old-entry':legacy};
 const s={get:(table,id)=>table==='showcase-exit-plan'?records['update:'+id]:records[id]};
 let p=showcasePositions(s,[first])[0];
 assert.equal(p.exitPlan.state,'ai-managed');assert.equal(p.exitPlan.deadlineAt,null);
 assert.deepEqual(p.exitPlan.rule,{takeProfitPct:null,stopLossPct:null,maxHoldMinutes:null});
 assert.deepEqual(p.exitPlan.previousRule,{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60});
 records['update:old-entry']={id:'old-entry',agentId:first.agentId,token,policyVersion:2,updatedAt:3000,takeProfitPct:1000,stopLossPct:null,maxHoldMinutes:null};
 p=showcasePositions(s,[first])[0];assert.equal(p.exitPlan.state,'active');assert.equal(p.exitPlan.rule.takeProfitPct,1000);assert.equal(p.exitPlan.previousRule,null);assert.equal(p.exitPlan.openedAt,1000);assert.equal(p.exitPlan.deadlineAt,null);
 records['update:old-entry'].agentId='other-agent';assert.equal(showcasePositions(s,[first])[0].exitPlan.state,'ai-managed');
 assert.deepEqual(records['old-entry'],legacy,'Original entry evidence is never rewritten');
});

test('missing oldest-entry rules stay unknown instead of borrowing another entry or a new model proposal',()=>{
 const [p]=showcasePositions(store({'new-entry':newRule}),[first,second]);
 assert.equal(p.exitPlan.state,'missing');assert.equal(p.exitPlan.rule,null);assert.equal(p.exitPlan.deadlineAt,null);
 const legacy=showcasePositions(store({['showcase-trend:'+token]:oldRule}),[first])[0];
 assert.equal(legacy.exitPlan.rule.stopLossPct,5);assert.equal(legacy.exitPlan.state,'active');
});
