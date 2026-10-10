import {encodeFunctionData,decodeFunctionResult} from 'viem';
const ALLOWED=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBlockReceipts','eth_getLogs','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getCode','eth_call','eth_gasPrice']);
export const hexBlock=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid block number');return '0x'+n.toString(16);};
export function publicEndpoint(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.hostname==='localhost'||u.hostname.endsWith('.local')||u.hostname.startsWith('[')||/^\d+(\.\d+){3}$/.test(u.hostname))throw Error('RPC 必须使用公开 HTTPS 地址');return u.href;}
export class CloudRpc{
 constructor(url='https://bsc-rpc.publicnode.com',{fetchImpl=(...args)=>fetch(...args)}={}){this.url=publicEndpoint(url);this.fetch=fetchImpl;this.chain='bsc';this.cache=new Map();this.pending=new Map();this.id=0;this.tail=Promise.resolve();}
 async request(method,params=[]){if(!ALLOWED.has(method))throw Error('Cloud RPC is read-only');
  const execute=async()=>{let r;try{r=await this.fetch(this.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++this.id,method,params})});}catch{throw Error('BSC RPC 网络不可用');}if(!r.ok)throw Error('BSC RPC 请求失败：HTTP '+r.status);const data=await r.json();if(data.error||!Object.hasOwn(data,'result'))throw Error('BSC RPC 未返回有效读取结果');return data.result;};
  // Shared bounded concurrency avoids public RPC bursts from route discovery.
  const task=this.tail.catch(()=>{}).then(execute);this.tail=task;return task;
 }
 async read(token,abi,fn,args=[],block,from){const params=[{to:token,...(from?{from}:{}),data:encodeFunctionData({abi,functionName:fn,args})},block===undefined?'latest':hexBlock(block)],id=JSON.stringify(params);if(this.pending.has(id))return this.pending.get(id);const p=this.request('eth_call',params).then(data=>decodeFunctionResult({abi,functionName:fn,data})).finally(()=>this.pending.delete(id));this.pending.set(id,p);return p;}
 async block(number,force=false){if(!this.verified){if(BigInt(await this.request('eth_chainId'))!==56n)throw Error('RPC 并非 BSC 主网');this.verified=true;}if(number!==undefined&&!force&&this.cache.has(number))return this.cache.get(number);const raw=await this.request('eth_getBlockByNumber',[number===undefined?'latest':hexBlock(number),false]);if(!raw?.hash||!Array.isArray(raw.transactions))throw Error('BSC 区块读取失败');const b={number:Number(BigInt(raw.number)),hash:raw.hash,parentHash:raw.parentHash,time:Number(BigInt(raw.timestamp))*1000,transactions:raw.transactions};this.cache.set(b.number,b);if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value);return b;}
 knownBlock(number){return this.cache.get(number);}
 receipt(hash){return this.request('eth_getTransactionReceipt',[hash]);}
 logs(filter){return this.request('eth_getLogs',[filter]);}
 promote(){} linkPending(p){return p;} withPriority(fn){return fn();} withBackground(fn){return fn();} close(){}
}
