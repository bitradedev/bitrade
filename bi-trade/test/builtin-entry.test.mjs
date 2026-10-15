import test from 'node:test';
import assert from 'node:assert/strict';
import {volumeEligibility,assertVolume5m,validateNarrative} from '../lib/builtin-entry-policy.mjs';
import {validateDecision,decisionSchema} from '../lib/ai-provider.mjs';
const at=1760000000000,token='0x'+'11'.repeat(20);
const volume=usd=>({usd,at,windowMs:300000,quality:'observed-lower-bound',fromTime:at-300000,toTime:at-2000});
const unknown={verdict:'unknown',thesis:'未取得独立叙事资料',catalyst:null,risks:'同名与传播情况未知',evidenceIds:[]};
const evidence={sources:[{id:'project-description',independent:false}]};
test('builtin five-minute rule accepts exactly 3000, rejects stale/future/wrong-window/unknown data and never substitutes 24h volume',()=>{
 assert.equal(volumeEligibility(volume(3000),at).allowed,true);
 for(const v of [volume(2999.99),null,{...volume(5000),at:at+1},{...volume(5000),at:at-15000},{...volume(5000),windowMs:86400000},{...volume(5000),fromTime:at-300001},{...volume(5000),usd:Infinity},{volumeUsd:1e6}])assert.throws(()=>assertVolume5m(v,at));
});
test('narrative assessments distinguish project claims, unknowns and independent evidence; invented citations fail',()=>{
 assert.deepEqual(validateNarrative(unknown,{sources:[]}),unknown);
 const claim={...unknown,verdict:'speculative',evidenceIds:['project-description']};
 assert.equal(validateNarrative(claim,evidence).verdict,'speculative');
 for(const n of [null,{...claim,verdict:'supported'},{...claim,evidenceIds:['invented']},{...unknown,verdict:'supported'},{...unknown,risks:''}])assert.throws(()=>validateNarrative(n,evidence));
 assert.equal(validateNarrative({...claim,verdict:'supported'},{sources:[{id:'project-description',independent:true}]}).verdict,'supported');
});
test('builtin buy validates both volume and narrative, while held exits and external contexts retain autonomy',()=>{
 const context={at,executionConstraints:{requiresNarrativeAssessment:true},account:{balanceUsd:1000,positions:[{token}]},markets:[{token,entryEvidence:{volume5m:volume(3000),narrative:evidence}}]};
 const buy={action:'buy',token,sizeUsd:100,reason:'项目叙事关联尚未证实，结合短线成交谨慎评估',exit:null,narrative:unknown};
 assert.equal(validateDecision({...buy},context).action,'buy');
 assert.throws(()=>validateDecision({...buy,narrative:null},context),/叙事/);
 const low={...context,markets:[{token,entryEvidence:{volume5m:volume(2999),narrative:evidence}}]};
 assert.throws(()=>validateDecision({...buy},low),/3,000/);
 assert.equal(validateDecision({...buy,action:'sell',sizeUsd:null,narrative:null},low).action,'sell');
 assert.equal(validateDecision({...buy,narrative:null},{...low,executionConstraints:{}}).action,'buy');
 assert.ok(decisionSchema.required.includes('narrative'));
});
