// Test-only entry point. Never included in the deployment entry point.
export {default,TradingPlatform} from '../worker.js';
import {TradingPlatform} from '../worker.js';
import {DurableObject} from 'cloudflare:workers';
import {GmgnHTTP} from '../gmgn.mjs';
import {CloudRpc} from '../rpc.mjs';
import {OpenAIPlanner} from '../../bi-trade/lib/ai-provider.mjs';
import {CloudStore} from '../store.mjs';
import {PaperDesk} from '../../bi-trade/lib/paper-desk.mjs';
import {publicAgent,leaderboard} from '../../bi-trade/lib/public-agents.mjs';
import {MemeBscData} from '../meme-data.mjs';
import {TokenRiskGuard} from '../../bi-trade/lib/token-risk-core.mjs';
export class EntityReadProbe extends DurableObject {
 store:any; rowsRead=0; rowsWritten=0;
 constructor(ctx:any,env:any){
  super(ctx,env);
  this.store=new CloudStore({transactionSync:ctx.storage.transactionSync.bind(ctx.storage),sql:{exec:(...args:any[])=>{
   const c=ctx.storage.sql.exec(...args);
   return {toArray:()=>{const rows=c.toArray();this.rowsRead+=c.rowsRead;this.rowsWritten+=c.rowsWritten;return rows;},get rowsWritten(){return c.rowsWritten;}};
  }}});
 }
 async fetch(){
  const token='0x'+'12'.repeat(20);
  for(let i=0;i<3;i++){
   const id='profile-'+i;
   this.store.put('agents',{id,public:true,source:'builtin',mode:'paper',createdAt:i,address:'0x'+String(i+1).padStart(40,'0')});
   this.store.put('paper-accounts',{id,initialUsd:1000,nativeRaw:'1000000000000000000',realizedNativeRaw:'0'});
   for(let f=0;f<20;f++)this.store.put('paper-fills',{id:id+'-'+f,agentId:id,token,side:'sell',netRaw:'0',netUsd:0,at:f});
  }
  this.store.put('cloud-meme-candidates',{id:token,address:token,active:true,category:'meme',entryRank:0});
  this.store.put('token-risk-reports',{id:token,token,fetchedAt:Date.now(),buyAllowed:false,state:'unknown',reasons:['unknown']});
  const paper=new PaperDesk(this.store,{statuses:()=>[],markets:()=>[]}),data=new MemeBscData(this.store,{}),risk=new TokenRiskGuard(this.store,{source:{}});
  const read=()=>({agents:this.store.all('agents').map((a:any)=>publicAgent(this.store,paper,null,a)),rank:leaderboard(this.store,paper,null,new URL('https://probe/')).entries,sources:data.status(),screening:Array.from({length:4},()=>data.candidates().map((c:any)=>({supported:data.supports(c.address),risk:risk.snapshot(c.address)})))});
  const cache=this.store.entityReads;
  this.store.entityReads=null;this.rowsRead=0;this.rowsWritten=0;const baseline=read(),uncachedRows=this.rowsRead,uncachedWrites=this.rowsWritten;
  this.store.entityReads=cache;cache?.clear();this.rowsRead=0;this.rowsWritten=0;const cached=read(),cachedRows=this.rowsRead,cachedWrites=this.rowsWritten;
  return Response.json({baseline,cached,uncachedRows,cachedRows,uncachedWrites,cachedWrites});
 }
}
export class NetworkProbe extends DurableObject{
 async fetch(){const info=await new GmgnHTTP('dummy-api').info('bsc','0x1111111111111111111111111111111111111111');const chain=await new CloudRpc('https://rpc.example.com').request('eth_chainId');
  const decision=await new OpenAIPlanner().decide({apiKey:'dummy-api',model:'test',baseUrl:'https://ai.example.com/v1'},{description:'test'},{account:{balanceUsd:1000,positions:[]},markets:[]});
  return Response.json({info,chain,decision});
 }
}
export class ReadOnlyProbe extends TradingPlatform {
 async fetch(request:Request){
  if(new URL(request.url).pathname==='/__test/protect'){
   await this.initialize();await this.ctx.storage.deleteAlarm();
   this.store.readOnlyUntil=Date.now()+3600000;this.app=null;this.market=null;this.risk=null;
   const prepare=this.store.db.prepare.bind(this.store.db);
   this.store.db.prepare=(q:string)=>{const s=prepare(q);return {...s,run:()=>{throw Error('Test: SQL writes are unavailable');}};};
   return Response.json({protected:true});
  }
  return super.fetch(request);
 }
}
export class BudgetProbe extends TradingPlatform {
 async fetch(request:Request){
  const path=new URL(request.url).pathname;
  if(path==='/__test/exhaust'){
   await this.initialize();await this.ctx.storage.deleteAlarm();this.store.budget.record(80000);
   return Response.json({recorded:true});
  }
  if(path==='/__test/next-day'){
   const now=Date.now()+86400000;this.store.now=()=>now;this.store.budget.now=()=>now;
   return Response.json({advanced:true});
  }
  return super.fetch(request);
 }
}
export class QuotaFailure extends DurableObject {
 async fetch(){throw Error('Exceeded allowed rows written in Durable Objects free tier.');}
}
export class OverdueWakeProbe extends TradingPlatform {
 async fetch(request:Request){
  const original=this.ctx.storage.getAlarm.bind(this.ctx.storage);
  if(new URL(request.url).pathname==='/recover'){
   const previousAt=Date.now()-3600000;
   this.ctx.storage.getAlarm=async()=>previousAt;
   try{await this.arm(1000);}finally{this.ctx.storage.getAlarm=original;}
   return Response.json({previousAt,nextAt:await original()});
  }
  const previousAt=Date.now()+10000;await this.ctx.storage.setAlarm(previousAt);await this.arm(20000);
  return Response.json({previousAt,nextAt:await original()});
 }
 async alarm(){await this.ctx.storage.deleteAlarm();}
}
export class SchedulerProbe extends TradingPlatform {
 refreshes=0; watches=0; matches=0; modelCalls=0;
 async arm(){await this.ctx.storage.deleteAlarm();}
 initialize(){
  if(!this.app){
   this.market={refresh:async()=>{this.refreshes++;await this.io.fetch('https://price.example.com');},pulse:async()=>{}};
   this.risk={tick(){},task:null};
   this.app={paper:{orders:()=>[],tick:async()=>{this.matches++;}},showcase:{freshMarkets:()=>[],watchExits:async()=>{this.watches++;},tick:async()=>{this.modelCalls++;await this.io.fetch('https://slow-ai.example.com');await this.io.fetch('https://after-ai.example.com');}}};
  }
  return Promise.resolve(this.app);
 }
 async fetch(request:Request){
  const path=new URL(request.url).pathname;
  if(path==='/round')await this.alarm();
  if(path==='/finish')await this.decisionTask;
  return Response.json({refreshes:this.refreshes,watches:this.watches,matches:this.matches,modelCalls:this.modelCalls,active:Boolean(this.decisionTask),budget:this.io.lastAlarm,decisionBudget:this.io.lastDecision});
 }
}
