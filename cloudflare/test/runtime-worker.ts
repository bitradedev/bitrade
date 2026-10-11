// Test-only entry point. Never included in the deployment entry point.
export {default,TradingPlatform} from '../worker.js';
import {TradingPlatform} from '../worker.js';
import {DurableObject} from 'cloudflare:workers';
import {GmgnHTTP} from '../gmgn.mjs';
import {CloudRpc} from '../rpc.mjs';
import {OpenAIPlanner} from '../../bi-trade/lib/ai-provider.mjs';
export class NetworkProbe extends DurableObject{
 async fetch(){const info=await new GmgnHTTP('dummy-api').info('bsc','0x1111111111111111111111111111111111111111');const chain=await new CloudRpc('https://rpc.example.com').request('eth_chainId');
  const decision=await new OpenAIPlanner().decide({apiKey:'dummy-api',model:'test',baseUrl:'https://ai.example.com/v1'},{description:'test'},{account:{balanceUsd:1000,positions:[]},markets:[]});
  return Response.json({info,chain,decision});
 }
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
