import type { Candle, Chain, Horizon, MarketEvent } from '../shared/domain.js';

/** All times in milliseconds. Supply ONLY point-in-time, verified observations. */
export interface SignalTrade {id:string;at:number;receivedAt:number;priceUsd:number;amountUsd:number;side:'buy'|'sell';verified:boolean;removed?:boolean;}
export interface SignalBar extends Candle {receivedAt:number;complete:boolean;}
export interface MomentumContext {
  chain:Chain;token:string;now:number;createdAt:number;priceUsd:number;priceAt:number;
  coverageStart:number;hasGap:boolean;trades:readonly SignalTrade[];
  minuteBars?:readonly SignalBar[];fiveMinuteBars?:readonly SignalBar[];
}
export interface SignalDecision {eligible:boolean;reason:string;signalAt:number|null;priceUsd:number|null;details:Record<string,number|string>;}
const no=(reason:string,details:SignalDecision['details']={}):SignalDecision=>({eligible:false,reason,signalAt:null,priceUsd:null,details});
const yes=(reason:string,at:number,priceUsd:number,details:SignalDecision['details']):SignalDecision=>({eligible:true,reason,signalAt:at,priceUsd,details});
const valid=(n:number)=>Number.isFinite(n)&&n>0;
function contextOkay(c:MomentumContext):boolean {return Number.isFinite(c.now)&&valid(c.priceUsd)&&c.priceAt<=c.now&&c.now-c.priceAt<=5_000&&!c.hasGap;}
export function evaluateShortSignal(c:MomentumContext):SignalDecision {
  if(!contextOkay(c))return no('fresh verified market data required');
  const age=c.now-c.createdAt;
  if(age<0||age>=600_000)return no('token age must be less than ten minutes');
  if(c.coverageStart>c.now-60_000)return no('need complete preceding sixty-second trade coverage');
  const seen=new Set<string>();
  const trades=c.trades.filter(t=>{
    if(seen.has(t.id))return false;seen.add(t.id);
    return t.verified&&!t.removed&&t.at<=c.now&&t.receivedAt<=c.now&&t.receivedAt>=t.at&&valid(t.priceUsd)&&Number.isFinite(t.amountUsd)&&t.amountUsd>0;
  });
  const prior=trades.filter(t=>t.at>c.now-60_000&&t.at<=c.now-30_000);
  const latest=trades.filter(t=>t.at>c.now-30_000&&t.at<=c.now);
  if(!prior.length||!latest.length)return no('both thirty-second windows need verified trades');
  const high=Math.max(...prior.map(t=>t.priceUsd));
  const priorVolume=prior.reduce((n,t)=>n+t.amountUsd,0),volume=latest.reduce((n,t)=>n+t.amountUsd,0);
  const buy=latest.filter(t=>t.side==='buy').reduce((n,t)=>n+t.amountUsd,0),sell=latest.filter(t=>t.side==='sell').reduce((n,t)=>n+t.amountUsd,0);
  const details={previousHigh:high,previousVolumeUsd:priorVolume,latestVolumeUsd:volume,buyVolumeUsd:buy,sellVolumeUsd:sell,ageMs:age};
  if(c.priceUsd<=high)return no('no breakout of preceding thirty-second high',details);
  if(volume+1e-10<priorVolume*2)return no('latest volume is below twice preceding volume',details);
  if(buy<=0||buy+1e-10<sell*1.5)return no('buy volume is below 1.5 times sell volume',details);
  return yes('new-token breakout, volume expansion and buy imbalance',c.now,c.priceUsd,details);
}
function completeBars(bars:readonly SignalBar[],period:number,now:number):SignalBar[] {
  return bars.filter(b=>b.complete&&b.receivedAt<=now&&b.time+period<=now&&b.time%period===0&&[b.open,b.high,b.low,b.close].every(valid)
    &&Number.isFinite(b.volume)&&b.volume>=0&&b.low<=Math.min(b.open,b.close)&&b.high>=Math.max(b.open,b.close))
    .sort((a,b)=>a.time-b.time);
}
function contiguous(bars:readonly SignalBar[],period:number):boolean {return bars.every((b,i)=>i===0||b.time-bars[i-1].time===period);}
export function evaluateSwingSignal(c:MomentumContext):SignalDecision {
  if(!contextOkay(c))return no('fresh verified market data required');
  const one=completeBars(c.minuteBars??[],60_000,c.now).slice(-21);
  if(one.length<21||!contiguous(one,60_000)||one.at(-1)?.time!==Math.floor(c.now/60_000)*60_000-60_000)return no('need twenty prior and one latest COMPLETE continuous minute bars');
  const latest=one[20],prior=one.slice(0,20);
  const high=Math.max(...prior.map(b=>b.high)),avg=prior.reduce((n,b)=>n+b.volume,0)/20;
  const details:SignalDecision['details']={previousHigh:high,previousMeanVolume:avg,latestClose:latest.close,latestVolume:latest.volume};
  if(latest.close<=high||c.priceUsd<=high)return no('no breakout above prior twenty complete minute bars',details);
  if(avg<=0||latest.volume+1e-10<avg*2)return no('minute volume below twice prior mean',details);
  const five=completeBars(c.fiveMinuteBars??[],300_000,c.now);
  if(five.length<21||!contiguous(five,300_000)||five.at(-1)?.time!==Math.floor(c.now/300_000)*300_000-300_000)return no('need continuous complete five-minute bars for EMA20',details);
  let ema=five.slice(0,20).reduce((n,b)=>n+b.close,0)/20,previous=ema;
  for(let i=20;i<five.length;i++){previous=ema;ema=five[i].close*(2/21)+ema*(19/21);}
  Object.assign(details,{ema20:ema,previousEma20:previous});
  if(ema<=previous||c.priceUsd<=ema)return no('five-minute EMA20 must rise and price must be above it',details);
  return yes('minute breakout with volume expansion and rising five-minute EMA20',c.now,c.priceUsd,details);
}

export interface WalletSignalContext {
  chain:Chain;horizon:Horizon;now:number;event:MarketEvent;wallets:readonly string[];
  /** Verified target ACTUAL net fill price, not an unverified screen/reference price. */
  targetEntryPriceUsd:number;ourExecutablePriceUsd:number;
  firstVerifiedBuy:boolean;
  /** Main persists per-chain wallet/token first-buy keys across restart. */
  seenFirstBuys:ReadonlySet<string>;
}
export function walletSignalKey(chain:Chain,wallet:string,token:string):string {return `${chain}:${wallet.toLowerCase()}:${token.toLowerCase()}`;}
export function evaluateWalletSignal(c:WalletSignalContext):SignalDecision {
  const e=c.event;
  if(e.chain!==c.chain||e.kind!=='wallet'||e.side!=='buy'||!e.wallet||!e.token||!c.wallets.some(w=>w.toLowerCase()===e.wallet?.toLowerCase()))return no('not a watched wallet buy');
  if(!c.firstVerifiedBuy||e.firstBuy!==true||e.payload.verified!==true||e.replayed||e.payload.add===true)return no('only first receipt-verified buy; ignore sells, adds and replay');
  const key=walletSignalKey(c.chain,e.wallet,e.token);
  if(c.seenFirstBuys.has(key))return no('first buy already consumed');
  const maxAge=c.horizon==='short'?5_000:60_000;
  if(e.at>c.now||e.receivedAt>c.now||e.receivedAt<e.at||c.now-e.at>maxAge)return no('wallet signal expired or future timestamp');
  if(!valid(c.targetEntryPriceUsd)||!valid(c.ourExecutablePriceUsd))return no('both executable and target fill prices are required');
  const premium=(c.ourExecutablePriceUsd/c.targetEntryPriceUsd-1)*100;
  if(premium>10+1e-10)return no('executable price is more than ten percent above target entry',{premiumPct:premium});
  return yes('fresh first verified wallet buy within price premium cap',e.at,c.ourExecutablePriceUsd,{premiumPct:premium,wallet:e.wallet,key});
}
export function evaluateMomentumSignal(horizon:Horizon,context:MomentumContext):SignalDecision {return horizon==='short'?evaluateShortSignal(context):evaluateSwingSignal(context);}
