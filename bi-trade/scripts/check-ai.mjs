import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PlatformStore,fail} from '../lib/database.mjs';
import {WalletVault} from '../lib/vault.mjs';
import {readAIConfig,OpenAIPlanner,DEFAULT_BASE_URL,reserveAICall} from '../lib/ai-provider.mjs';

const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../data'),store=new PlatformStore(directory);
let config,metadataStatus=null,stage='authentication';
function record(valid,reason){store.put('ai-validation',{id:'provider',valid,stage,configurationUpdatedAt:store.get('settings','ai-provider')?.updatedAt??null,checkedAt:Date.now(),reason});return {configured:!!config,valid,stage,status:metadataStatus,model:config?.model,baseUrl:config?.baseUrl,intervalMinutes:config?.intervalMinutes,dailyCalls:config?.dailyCalls,reason};}
try{
 const vault=new WalletVault(directory,{existingWallets:store.all('agents').length>0});config=readAIConfig(store,vault);
 if(!config)throw fail('尚未配置 AI 服务商');
 const official=config.baseUrl===DEFAULT_BASE_URL;
 const response=await fetch(config.baseUrl+(official?'/models/'+encodeURIComponent(config.model):'/models'),{headers:{Authorization:'Bearer '+config.apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});
 metadataStatus=response.status;
 if(!response.ok)throw fail(response.status===401?'AI 服务商密钥验证失败（HTTP 401），调用已停用，请核对密钥和 API 地址。':'AI 服务商访问检查失败（HTTP '+response.status+'），调用已停用。');
 let metadata;try{metadata=await response.json();}catch{throw fail('AI 服务商模型信息格式无效，调用已停用。');}
 if(official?metadata?.id!==config.model:!Array.isArray(metadata?.data)||!metadata.data.some(x=>x?.id===config.model))throw fail('AI 服务商未提供当前配置的模型，调用已停用。');
 if(process.argv.includes('--decision')){
  stage='decision';
  if(!reserveAICall(store,config))throw fail('今日 AI 调用额度已用完，尚未进行决策格式检查。');
  const context={at:Date.now(),chainId:56,account:{initialUsd:1000,balanceUsd:1000,realizedUsd:0,positions:[]},markets:[]};
  const d=await new OpenAIPlanner().decide(config,{description:'这是连接检查。没有候选市场或持仓，必须 hold，简短说明等待真实行情。'},context);
  if(d.action!=='hold')throw fail('连接检查返回了无效交易动作，调用已停用。');
 }
 console.log(JSON.stringify(record(true,stage==='decision'?'AI 服务商连接及决策格式检查通过':'AI 服务商模型访问检查通过')));
}catch(e){
 console.log(JSON.stringify(record(false,e?.status?e.message:'AI 检查未完成，可能是网络不可用；调用已停用，未输出密钥或服务商响应内容。')));process.exitCode=1;
}finally{store.close();}
