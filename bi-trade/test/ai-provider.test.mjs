import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {PlatformStore} from '../lib/database.mjs';
import {WalletVault} from '../lib/vault.mjs';
import {saveAIConfig,readAIConfig,OpenAIPlanner,validateDecision,DEFAULT_MODEL,DEFAULT_BASE_URL,normalizeAIBaseUrl} from '../lib/ai-provider.mjs';
const TOKEN='0x'+'11'.repeat(20),config={apiKey:'test-secret-key-not-real',model:DEFAULT_MODEL,intervalMinutes:15,dailyCalls:300};
const context={account:{balanceUsd:1000,positions:[]},markets:[{token:TOKEN,priceUsd:1,liquidityUsd:null,prices:[]}]};
const buy=()=>({action:'buy',token:TOKEN,sizeUsd:150,reason:'依据真实测试输入提出150U模拟买入，设定退出条件。',exit:{takeProfitPct:10,stopLossPct:5,maxHoldMinutes:60}});
test('local OpenAI configuration is encrypted, reloadable and never returned with the API key',t=>{
 const root=resolve('bi-trade/data/test-runs');mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'ai-')),store=new PlatformStore(dir),vault=new WalletVault(dir);
 t.after(()=>{store.close();assert.ok(dir.startsWith(root+'\\')||dir.startsWith(root+'/'));rmSync(dir,{recursive:true,force:true});});
 assert.equal(readAIConfig(store,vault,{}),null);const saved=saveAIConfig(store,vault,config);assert.doesNotMatch(JSON.stringify(saved),/test-secret/);assert.doesNotMatch(JSON.stringify(store.get('settings','ai-provider')),/test-secret/);assert.deepEqual(readAIConfig(store,vault,{}),{...config,baseUrl:DEFAULT_BASE_URL});assert.equal(readAIConfig(store,vault,{BI_TRADE_AI_API_KEY:'environment-secret'}).apiKey,'environment-secret');
 assert.throws(()=>saveAIConfig(store,vault,{...config,apiKey:'secret\nheader'}));assert.throws(()=>saveAIConfig(store,vault,{...config,dailyCalls:0}));
 const unlimited=saveAIConfig(store,vault,{...config,intervalMinutes:1,dailyCalls:null});assert.equal(unlimited.dailyCalls,null);assert.equal(readAIConfig(store,vault,{}).dailyCalls,null);assert.equal(readAIConfig(store,vault,{}).intervalMinutes,1);
});
test('compatible provider URL normalization rejects credentials, insecure or ambiguous destinations',()=>{
 assert.equal(normalizeAIBaseUrl(),DEFAULT_BASE_URL);
 assert.equal(normalizeAIBaseUrl('https://provider.example'), 'https://provider.example/v1');
 assert.equal(normalizeAIBaseUrl('https://provider.example/api/v1/'), 'https://provider.example/api/v1');
 for(const url of ['http://provider.example','https://user:secret@provider.example','https://provider.example/?key=secret','https://provider.example/#secret','https://127.0.0.1','https://localhost','https://[::1]','https://provider.example/%2fsecret'])assert.throws(()=>normalizeAIBaseUrl(url));
});
test('configured compatible endpoint gets strict decisions without redirects, secret context or fallback to another host',async()=>{
 let calls=0;const relay={...config,baseUrl:'https://provider.example/v1',model:'relay-model'};
 const planner=new OpenAIPlanner({fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://provider.example/v1/responses');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+config.apiKey);const body=JSON.parse(options.body);assert.equal(body.model,'relay-model');assert.equal(body.text.format.strict,true);assert.doesNotMatch(JSON.stringify(body),/test-secret/);return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(buy())}]}]})};}});
 assert.equal((await planner.decide(relay,{description:'测试'},context)).action,'buy');assert.equal(calls,1);
 const malicious=new OpenAIPlanner({fetchImpl:async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({...buy(),reason:config.apiKey})}]}]})})});
 await assert.rejects(malicious.decide(relay,{description:'测试'},context),/无效敏感内容/);
});
test('OpenAI Responses uses strict structured decisions, does not send the key as context, and permits sizes above 40U',async()=>{
 let payload;const planner=new OpenAIPlanner({fetchImpl:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+config.apiKey);payload=JSON.parse(options.body);return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(buy())}]}]})};}});
 const result=await planner.decide(config,{description:'测试真实采样'},context);assert.equal(result.sizeUsd,150);assert.equal(payload.text.format.strict,true);assert.equal(payload.text.format.schema.additionalProperties,false);assert.equal(payload.store,false);assert.doesNotMatch(JSON.stringify(payload.input),/test-secret-key/);assert.equal(payload.model,DEFAULT_MODEL);
 assert.match(payload.input[0].content,/exitPlan 是当前实际生效/);assert.match(payload.input[0].content,/hold 和 sell 的 exit 字段不更新已有规则/);assert.match(payload.input[0].content,/state=missing/);
});
test('invalid, unaffordable, non-candidate and unowned AI decisions do not become trades',()=>{
 assert.throws(()=>validateDecision({...buy(),sizeUsd:1000},context),/余额不足/);
 assert.throws(()=>validateDecision({...buy(),token:'0x'+'22'.repeat(20)},context),/候选市场/);
 assert.throws(()=>validateDecision({...buy(),action:'sell',sizeUsd:null},context),/持仓/);
 assert.throws(()=>validateDecision({...buy(),exit:{takeProfitPct:10,stopLossPct:100,maxHoldMinutes:60}},context),/退出条件/);
 assert.throws(()=>validateDecision({...buy(),action:'hold'},context),/观察决策/);
});
test('provider failures and refusals are safe status messages, never leaked provider bodies or key',async()=>{
 const failure=new OpenAIPlanner({fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:config.apiKey})})});await assert.rejects(failure.decide(config,{},context),e=>e.message==='OpenAI 请求失败：HTTP 401');
 const refuse=new OpenAIPlanner({fetchImpl:async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'refusal',refusal:'no'}]}]})})});await assert.rejects(refuse.decide(config,{},context),/未完成/);
 const incomplete=new OpenAIPlanner({fetchImpl:async()=>({ok:true,json:async()=>({status:'incomplete',output:[]})})});await assert.rejects(incomplete.decide(config,{},context),/未完成/);
});
