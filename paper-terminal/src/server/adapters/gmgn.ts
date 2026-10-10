import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir,open,readFile,unlink,writeFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import type { Candle } from '../../shared/domain.js';
import { address, type Audit,type Chain, RouteBlocked } from './types.js';
import { cliScheduler,CliWait,type CliQueueOptions } from './cli-scheduler.js';
const run=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
// Source and compiled adapters have the same depth relative to the workspace.
const cli=resolve(root,'node_modules/gmgn-cli/dist/index.js');
const clock=resolve(root,'wallet-analysis/clock-sync.mjs');
const queueDir=resolve(root,'paper-terminal/src/server/adapters/runtime');
const lockFile=resolve(queueDir,'gmgn.lock'), nextFile=resolve(queueDir,'gmgn-next.json');
let cooldown=0;
export function validateCliArgs(args:string[]){
 const pair=args.slice(0,2).join(' ');if(!['token info','token security','token pool','token holders','market trenches','market kline'].includes(pair))throw new RouteBlocked('READ_ONLY','GMGN 只允许公开行情、元数据、安全字段和公开持仓');
 if(args.some(a=>/key|secret|sign|swap|private|config/i.test(a)))throw new RouteBlocked('READ_ONLY','禁止交易或账户配置命令');
 const ci=args.indexOf('--chain');if(ci<0||!['bsc','robinhood'].includes(args[ci+1]))throw Error('Invalid CLI chain');
 const ai=args.indexOf('--address');if(ai>=0)address(args[ai+1]);
}
export class GmgnReadQueue {
 private closed=false;
 constructor(private proxy='http://127.0.0.1:7897',private audit?:Audit){}
 request(args:string[],options:CliQueueOptions={}):Promise<any>{validateCliArgs(args);if(this.closed)return Promise.reject(new RouteBlocked('GMGN_CANCELLED','只读网关已停止'));return cliScheduler.enqueue(this,signal=>this.execute(args,signal),options);}
 private async execute(args:string[],signal:AbortSignal){
  if(signal.aborted)throw signal.reason;await mkdir(queueDir,{recursive:true});let lock;
  try{lock=await open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,at:Date.now()}));}catch(e:any){if(e.code!=='EEXIST')throw e;let live=true;try{const owner=JSON.parse(await readFile(lockFile,'utf8'));try{process.kill(owner.pid,0);}catch(k:any){live=k.code!=='ESRCH';}if(!live)await unlink(lockFile);}catch{}throw new CliWait(250);}
  try {
   let next=0,sharedCooldown=cooldown;try{const saved=JSON.parse(await readFile(nextFile,'utf8'));next=saved.next||0;sharedCooldown=Math.max(sharedCooldown,saved.cooldown||0);}catch{}
   if(Date.now()<Math.max(next,sharedCooldown)){const wait=Math.max(next,sharedCooldown)-Date.now();if(sharedCooldown>Date.now()||wait>300000)throw new RouteBlocked('GMGN_COOLDOWN','GMGN 处于限频冷却');throw new CliWait(wait);}
   if(signal.aborted)throw signal.reason;
   await writeFile(nextFile,JSON.stringify({next:Date.now()+2200,cooldown}));
   const env={...process.env,HTTP_PROXY:this.proxy,HTTPS_PROXY:this.proxy,ALL_PROXY:this.proxy,NODE_OPTIONS:''};
   // Config check deliberately avoids the asynchronous clock preload.
   await run(process.execPath,[cli,'config','--check'],{env,windowsHide:true,timeout:10000,maxBuffer:1024*1024,signal});
   const result=await run(process.execPath,['--import',pathToFileURL(clock).href,cli,...args,'--raw'],{env,windowsHide:true,timeout:35000,maxBuffer:8*1024*1024,signal});
   return JSON.parse(result.stdout.trim());
  }catch(e:any){
   if(e instanceof CliWait||e instanceof RouteBlocked)throw e;if(signal.aborted)throw new RouteBlocked('GMGN_CANCELLED','只读请求已取消');
   const diagnostic=String(e.stderr||'');if(/429|RATE_LIMIT/.test(diagnostic)){const reset=/"reset_at"\s*:\s*(\d+)/.exec(diagnostic);cooldown=reset?Number(reset[1])*1000:Date.now()+300000;await writeFile(nextFile,JSON.stringify({next:Date.now()+2200,cooldown}));}
   const reason=cooldown>Date.now()?'GMGN 限频，已暂停元数据请求':'GMGN 只读请求失败（认证、网络或数据不可用）';this.audit?.('gateway',reason,{command:args.slice(0,2).join(' ')});throw new RouteBlocked('GMGN_UNAVAILABLE',reason);
  }finally{await lock.close();await unlink(lockFile).catch(()=>{});}
 }
 close(){this.closed=true;cliScheduler.cancel(this);}
 queueStats(){return cliScheduler.stats();}
 info(chain:Chain,token:string,options:CliQueueOptions={}){return this.request(['token','info','--chain',chain,'--address',address(token)],options);}
 security(chain:Chain,token:string){return this.request(['token','security','--chain',chain,'--address',address(token)]);}
 holders(chain:Chain,token:string){return this.request(['token','holders','--chain',chain,'--address',address(token),'--limit','100']);}
 pool(chain:Chain,token:string){return this.request(['token','pool','--chain',chain,'--address',address(token)]);}
 seeds(chain:Chain){return this.request(['market','trenches','--chain',chain,'--type','new_creation','near_completion','completed','--limit','15']);}
 async candles(chain:Chain,token:string,chainTime?:number,options:CliQueueOptions={}){const now=Math.floor((chainTime||Date.now())/1000),data=unwrap(await this.request(['market','kline','--chain',chain,'--address',address(token),'--resolution','30s','--from',String(now-7200),'--to',String(now)],{...options,priority:'interactive'}));const rows=Array.isArray(data)?data:data?.list;if(!Array.isArray(rows))throw new RouteBlocked('KLINE_SHAPE_UNKNOWN','历史服务返回未识别的K线格式');const candles=normalizeCandles(rows);if(rows.length&&!candles.length)throw new RouteBlocked('KLINE_VALUES_UNKNOWN','历史K线时间、价格或成交量字段无法核实');return candles;}
}
export function unwrap(data:any){return data?.data??data;}
export function normalizeCandles(rows:any[]):Candle[]{
 const unique=new Map<number,Candle>();for(const r of rows){const time=Number(r.time);const c={time:Math.floor(time>1e12?time/1000:time),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume)};if([c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)&&c.open>0&&c.low>0&&c.high>=c.low&&c.volume>=0)unique.set(c.time,c);}return [...unique.values()].sort((a,b)=>a.time-b.time).slice(-1000);
}
