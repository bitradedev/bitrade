import { RouteBlocked } from './types.js';

export type CliPriority='interactive'|'background';
export class CliWait extends Error {constructor(readonly delayMs:number){super('shared CLI budget not ready');}}
export interface CliQueueOptions {priority?:CliPriority;signal?:AbortSignal;timeoutMs?:number;}
interface CliJob<T=any>{owner:object;priority:CliPriority;sequence:number;deadline:number;run:(signal:AbortSignal)=>Promise<T>;controller:AbortController;resolve:(value:T)=>void;reject:(error:unknown)=>void;done:boolean;external?:AbortSignal;abort?:()=>void;timer?:ReturnType<typeof setTimeout>;}

/** All owners share one pipeline and its original 2200ms budget. A waiting
 * cross-process lock/rate slot returns CliWait so selection can be reprioritized
 * without sending another request or holding the lock while sleeping. */
export class CliScheduler {
 private jobs:CliJob[]=[];private active?:CliJob;private sequence=0;private next=0;private timer?:ReturnType<typeof setTimeout>;private lastOwner:Partial<Record<CliPriority,object>>={};
 constructor(private intervalMs=2200,private perOwnerLimit=16,private totalLimit=128){}
 enqueue<T>(owner:object,run:(signal:AbortSignal)=>Promise<T>,options:CliQueueOptions={}):Promise<T>{
  if(options.signal?.aborted)return Promise.reject(new RouteBlocked('GMGN_CANCELLED','只读请求已取消'));
  if(this.jobs.length>=this.totalLimit||this.jobs.filter(j=>j.owner===owner).length>=this.perOwnerLimit)return Promise.reject(new RouteBlocked('GMGN_QUEUE_FULL','只读数据队列已满，等待已有请求结束'));
  let job!:CliJob<T>;const p=new Promise<T>((resolve,reject)=>{job={owner,priority:options.priority??'background',sequence:++this.sequence,deadline:performance.now()+(options.timeoutMs??120000),run,controller:new AbortController(),resolve,reject,done:false,external:options.signal};});
  job.abort=()=>this.finish(job,undefined,new RouteBlocked('GMGN_CANCELLED','只读请求已取消'));job.external?.addEventListener('abort',job.abort,{once:true});job.timer=setTimeout(()=>this.finish(job,undefined,new RouteBlocked('GMGN_DEADLINE','只读数据等待/读取超过时限')),Math.max(1,job.deadline-performance.now()));this.jobs.push(job);this.pump();return p;
 }
 cancel(owner:object){for(const job of [...this.jobs,...(this.active?[this.active]:[])])if(job.owner===owner)this.finish(job,undefined,new RouteBlocked('GMGN_CANCELLED','只读网关已停止'));this.pump();}
 stats(){return {active:this.active?1:0,queued:this.jobs.length,interactiveQueued:this.jobs.filter(j=>j.priority==='interactive').length,backgroundQueued:this.jobs.filter(j=>j.priority==='background').length,intervalMs:this.intervalMs};}
 private finish(job:CliJob,value?:unknown,error?:unknown){if(job.done)return;job.done=true;this.jobs=this.jobs.filter(j=>j!==job);if(job.timer)clearTimeout(job.timer);if(job.abort)job.external?.removeEventListener('abort',job.abort);if(error){job.controller.abort(error);job.reject(error);}else job.resolve(value);this.pump();}
 private pump(){if(this.timer){clearTimeout(this.timer);this.timer=undefined;}if(this.active||!this.jobs.length)return;const wait=this.next-performance.now();if(wait>.25){this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},wait);return;}
  const priority=this.jobs.some(j=>j.priority==='interactive')?'interactive':'background';const lane=this.jobs.filter(j=>j.priority===priority).sort((a,b)=>a.sequence-b.sequence);const job=lane.find(j=>j.owner!==this.lastOwner[priority])??lane[0];
  this.jobs=this.jobs.filter(j=>j!==job);this.active=job;const started=performance.now();
  void (async()=>{try{const result=await job.run(job.controller.signal);this.next=Math.max(this.next,started+this.intervalMs);this.lastOwner[priority]=job.owner;this.finish(job,result);}catch(error){
   if(error instanceof CliWait&&!job.done){this.next=Math.max(this.next,performance.now()+Math.max(1,error.delayMs));this.jobs.push(job);}else{this.next=Math.max(this.next,started+this.intervalMs);this.lastOwner[priority]=job.owner;this.finish(job,undefined,error);}
  }finally{this.active=undefined;this.pump();}})();
 }
}
export const cliScheduler=new CliScheduler();
