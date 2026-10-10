import {randomBytes} from 'node:crypto';

// Operator diagnostic: only the existing read-only quote endpoint. No orders,
// balances, keys, signatures or broadcasts are created by this check.
const base='http://127.0.0.1:8790';
const state=await (await fetch(base+'/api/state')).json();
if(state.mode!=='paper'||state.health?.virtualOnly!==true)throw Error('来源不是虚拟交易终端');
const head=state.chains.find(c=>c.chain==='bsc');
if(!head?.connected||Date.now()-head.headAt>15000)throw Error('BSC链头暂不可用');
const markets=state.markets.filter(m=>m.chain==='bsc'&&m.quality==='verified'&&m.nativeUsd>0&&['flap','four'].includes(m.metadata?.route)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,2);
const recipient='0x'+randomBytes(20).toString('hex');let passed=false;
async function quote(m,side,amount,block){
 const params=new URLSearchParams({chain:'bsc',token:m.address,side,recipient,block:String(block),[side==='buy'?'nativeAmountRaw':'tokenAmountRaw']:amount});
 const res=await fetch(base+'/api/paper/quote?'+params,{headers:{'x-csrf-token':state.csrf},signal:AbortSignal.timeout(5000)});
 const body=await res.json();if(!res.ok)throw Error(body.error??'报价不可用');return body.quote;
}
for(const m of markets){try{
 const buy=await quote(m,'buy',BigInt(Math.floor(10/m.nativeUsd*1e18)).toString(),head.head);
 const sell=await quote(m,'sell',buy.outputRaw,buy.block);
 if(BigInt(buy.outputRaw)<=0n||BigInt(sell.outputRaw)<=0n||buy.block!==sell.block)throw Error('买卖数量或区块不一致');
 console.log(JSON.stringify({symbol:m.symbol,chain:'bsc',quoteOnly:true,usdBudget:10,venue:buy.venue,block:buy.block,buyQuality:buy.quality,sellQuality:sell.quality,gasEstimateUsd:buy.fees.gasUsd+sell.fees.gasUsd}));passed=true;break;
}catch(e){console.log(JSON.stringify({symbol:m.symbol,quoteOnly:true,error:e.message}));}}
if(!passed){console.log('本轮未取得完整BSC买卖报价；没有生成虚拟成交。');process.exitCode=1;}
