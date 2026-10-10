// Test-only entry point. Never included in the deployment entry point.
export {default,TradingPlatform} from '../worker.js';
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
