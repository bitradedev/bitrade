import { RouteBlocked } from './types.js';

export type RpcPriority='head'|'foreground'|'background';
const rank:Record<RpcPriority,number>={head:0,foreground:1,background:2};
interface Job<T=any>{owner:object;priority:RpcPriority;sequence:number;deadline:number;state:'queued'|'active'|'done';controller:AbortController;run:(signal:AbortSignal)=>Promise<T>;resolve:(value:T)=>void;reject:(error:unknown)=>void;timer?:ReturnType<typeof setTimeout>;}

/** One process-wide, paced budget. A slow scan cannot occupy the reserved head
 * slot or both normal slots. Preemption changes QUEUED work, never duplicates
 * an already sent request. Tests may inject a shorter interval. */
export class RpcScheduler {
 private queue:Job[]=[];private active=new Set<Job>();private links=new WeakMap<Promise<unknown>,Job>();private ownerBackoff=new WeakMap<object,number>();private sequence=0;private nextStart=0;private timer?:ReturnType<typeof setTimeout>;
 constructor(private intervalMs=180,private maxQueued=192){}
 schedule<T>(owner:object,priority:RpcPriority,run:(signal:AbortSignal)=>Promise<T>,deadline=performance.now()+(priority==='background'?15000:5000)):Promise<T>{
  const laneLimit=priority==='background'?Math.max(1,Math.floor(this.maxQueued*2/3)):priority==='foreground'?Math.max(1,Math.floor(this.maxQueued/4)):Math.max(1,Math.floor(this.maxQueued/12));
  if(this.queue.filter(j=>j.priority===priority).length>=laneLimit)return Promise.reject(new RouteBlocked('RPC_QUEUE_FULL',`${priority} 只读队列达到上限，保留其他优先级预算`));
  if(this.queue.length>=this.maxQueued)return Promise.reject(new RouteBlocked('RPC_QUEUE_FULL','只读请求队列已满，暂停后台任务后重试'));
  let job!:Job<T>;const promise=new Promise<T>((resolve,reject)=>{job={owner,priority,sequence:++this.sequence,deadline,state:'queued',controller:new AbortController(),run,resolve,reject};});
  this.links.set(promise,job);this.queue.push(job);this.armExpiry(job);this.pump();return promise;
 }
 link<T>(target:Promise<T>,source:Promise<unknown>){const job=this.links.get(source);if(job)this.links.set(target,job);return target;}
 promote(promise:Promise<unknown>,priority:RpcPriority,deadline?:number){const job=this.links.get(promise);if(!job||job.state==='done')return;
  if(job.state==='queued'&&rank[priority]<rank[job.priority])job.priority=priority;
  if(priority!=='background'&&deadline!==undefined&&deadline<job.deadline){job.deadline=deadline;this.armExpiry(job);}this.pump();
 }
 pause(ms:number,owner?:object){const until=performance.now()+ms;if(owner)this.ownerBackoff.set(owner,Math.max(this.ownerBackoff.get(owner)??0,until));else this.nextStart=Math.max(this.nextStart,until);this.pump();}
 cancel(owner:object){for(const job of [...this.queue,...this.active])if(job.owner===owner)this.fail(job,new RouteBlocked('RPC_STOPPED','只读网关已停止'));this.pump();}
 stats(){const now=performance.now(),count=(jobs:Job[],priority:RpcPriority)=>jobs.filter(j=>j.priority===priority).length;return {active:this.active.size,queued:this.queue.length,headActive:count([...this.active],'head'),foregroundActive:count([...this.active],'foreground'),backgroundActive:count([...this.active],'background'),headQueued:count(this.queue,'head'),foregroundQueued:count(this.queue,'foreground'),backgroundQueued:count(this.queue,'background'),intervalMs:this.intervalMs,nextStartDelayMs:Math.max(0,Math.ceil(this.nextStart-now)),backoffQueued:this.queue.filter(j=>(this.ownerBackoff.get(j.owner)??0)>now).length};}
 private armExpiry(job:Job){if(job.timer)clearTimeout(job.timer);job.timer=setTimeout(()=>{this.fail(job,new RouteBlocked('RPC_DEADLINE',`${job.priority} 只读请求超过等待/读取时限`));this.pump();},Math.max(1,job.deadline-performance.now()));}
 private fail(job:Job,error:unknown){if(job.state==='done')return;if(job.state==='queued')this.queue=this.queue.filter(j=>j!==job);job.state='done';if(job.timer)clearTimeout(job.timer);job.controller.abort(error);job.reject(error);}
 private eligible(job:Job){if(this.active.size>=3)return false;const active=[...this.active];if(job.priority==='head')return !active.some(j=>j.priority==='head');const normal=active.filter(j=>j.priority!=='head');if(normal.length>=2)return false;return job.priority!=='background'||!normal.some(j=>j.priority==='background');}
 private pump(){if(this.timer){clearTimeout(this.timer);this.timer=undefined;}const now=performance.now();for(const job of [...this.queue])if(job.deadline<=now)this.fail(job,new RouteBlocked('RPC_DEADLINE','排队期间只读请求已过期'));
  const eligible=this.queue.filter(j=>this.eligible(j)),job=eligible.filter(j=>(this.ownerBackoff.get(j.owner)??0)<=now).sort((a,b)=>rank[a.priority]-rank[b.priority]||a.sequence-b.sequence)[0];
  if(!job){const until=Math.min(...eligible.map(j=>this.ownerBackoff.get(j.owner)??Infinity));if(Number.isFinite(until)&&until>now)this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},until-now);return;}
  if(this.nextStart-now>.25){this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},this.nextStart-now);return;}
  this.queue=this.queue.filter(j=>j!==job);job.state='active';this.active.add(job);this.nextStart=now+this.intervalMs;
  void (async()=>{try{const result=await job.run(job.controller.signal);if(job.state!=='done'){job.state='done';job.resolve(result);}}catch(error){if(job.state!=='done'){job.state='done';job.reject(error);}}finally{if(job.timer)clearTimeout(job.timer);this.active.delete(job);this.pump();}})();this.pump();
 }
}
export const rpcScheduler=new RpcScheduler();
