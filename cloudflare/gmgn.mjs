import {randomUUID} from 'node:crypto';
const HOST='https://openapi.gmgn.ai',types=[6,7,1,16,8,3,9,10,2,17,18,0];
export const unwrap=value=>value?.data??value;
export class GmgnHTTP{
 constructor(key,{fetchImpl=(...args)=>fetch(...args),now=Date.now,store=null}={}){this.key=key;this.fetch=fetchImpl;this.now=now;this.store=store;this.tail=Promise.resolve();const saved=store?.get('cloud-settings','gmgn-budget');this.lastAt=saved?.lastAt??0;this.cooldown=saved?.cooldown??0;this.spacing=saved?.spacing??3000;this.cache=new Map();}
 request(path,params,body){const task=this.tail.catch(()=>{}).then(async()=>{
  if(!this.key)throw Error('尚未配置 GMGN 行情密钥');
  if(this.now()<this.cooldown)throw Error('GMGN 行情限频，等待额度恢复后自动重试');
  const wait=Math.max(0,this.spacing-(this.now()-this.lastAt));if(wait)await new Promise(r=>setTimeout(r,wait));this.lastAt=this.now();
  this.store?.put('cloud-settings',{id:'gmgn-budget',lastAt:this.lastAt,cooldown:this.cooldown,spacing:this.spacing});
  const url=new URL(path,HOST);for(const [k,v]of Object.entries({...params,timestamp:Math.floor(this.now()/1000),client_id:randomUUID()}))url.searchParams.set(k,String(v));
  const response=await this.fetch(url,{method:body?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'X-APIKEY':this.key,'Content-Type':'application/json','User-Agent':'bitrade-cloud/0.3'},body:body?JSON.stringify(body):undefined});
  if(response.status===429){let body;try{body=await response.json();}catch{}const reset=Number(body?.reset_at??body?.data?.reset_at??body?.error?.reset_at??response.headers.get('X-RateLimit-Reset'));this.cooldown=Number.isFinite(reset)&&reset*1000>this.now()&&reset*1000<this.now()+31*86400000?reset*1000+5000:this.now()+65000;this.spacing=Math.min(15000,Math.max(5000,this.spacing*2));const candidate=String(body?.error?.code??body?.error??body?.code??''),errorCode=/^[A-Z_0-9]{1,80}$/.test(candidate)?candidate:'RATE_LIMIT';this.store?.put('cloud-settings',{id:'gmgn-budget',lastAt:this.lastAt,cooldown:this.cooldown,spacing:this.spacing,errorCode});throw Error('GMGN 行情限频，等待额度恢复后自动重试');}
  if(response.status===401||response.status===403){this.cooldown=this.now()+300000;this.store?.put('cloud-settings',{id:'gmgn-budget',lastAt:this.lastAt,cooldown:this.cooldown,spacing:this.spacing,errorCode:'AUTHORIZATION_REQUIRED'});throw Error('GMGN 行情认证或访问权限未通过，暂停请求后重试');}
  if(!response.ok)throw Error('GMGN 行情请求失败：HTTP '+response.status);const data=await response.json();
  if(data.code!==undefined&&Number(data.code)!==0&&Number(data.code)!==200)throw Error('GMGN 行情返回错误');return {...data,_bitradeReadAt:this.now()};
 });this.tail=task;return task;}
 cached(name,address,ttl,load){const id=name+':'+address,old=this.cache.get(id);if(old&&this.now()-old.at<ttl)return old.task;const task=load().catch(e=>{this.cache.delete(id);throw e;});this.cache.set(id,{at:this.now(),task});if(this.cache.size>300)this.cache.delete(this.cache.keys().next().value);return task;}
 info(chain,address){return this.cached('info',address,60000,()=>this.request('/v1/token/info',{chain,address}));}
 security(chain,address){return this.cached('security',address,90000,()=>this.request('/v1/token/security',{chain,address}));}
 holders(chain,address){return this.cached('holders',address,90000,()=>this.request('/v1/market/token_top_holders',{chain,address,limit:100,order_by:'amount_percentage',direction:'desc'}));}
 trenches(){const section={filters:['offchain','onchain'],launchpad_platform_v2:true,limit:8,quote_address_type:types};return this.request('/v1/trenches',{chain:'bsc'},{version:'v2',new_creation:section,near_completion:section,completed:section});}
 close(){}
}
