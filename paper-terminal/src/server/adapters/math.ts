import { RouteBlocked,type Route,type RouteQuote } from './types.js';
export const BPS=10000n;
export const WAD=10n**18n;
export const ceilDiv=(a:bigint,b:bigint)=>{if(a<0n||b<=0n)throw new Error('Invalid division');return (a+b-1n)/b;};
export function amountOut(input:bigint,rin:bigint,rout:bigint){if(input<=0n||rin<=0n||rout<=0n)throw new RouteBlocked('EMPTY_RESERVES','报价储备为空');return input*rout/(rin+input);}
export function amountIn(output:bigint,rin:bigint,rout:bigint){if(output<=0n||output>=rout)throw new RouteBlocked('EMPTY_RESERVES','无法购买该数量');return output*rin/(rout-output)+1n;}
export interface PonsCurveState {quoteReserve:bigint;tokenReserve:bigint;sellable:bigint;feeBps:bigint;creatorTaxBps:bigint;snipeBps:bigint;ready:boolean;graduated:boolean;}
export function quotePons(state:PonsCurveState,side:'buy'|'sell',input:bigint){
 const {quoteReserve:q,tokenReserve:t,feeBps:f,creatorTaxBps:c}=state;
 if(input<=0n||f<0n||c<0n||f+c>=BPS)throw new RouteBlocked('INVALID_FEES','曲线费用不可核实');
 if(state.graduated||state.ready||state.sellable<=0n)throw new RouteBlocked('CURVE_CLOSED','曲线已关闭或等待毕业，当前不能买卖');
 if(side==='sell'){const gross=amountOut(input,t,q),protocol=gross*f/BPS,tax=gross*c/BPS;return {out:gross-protocol-tax,spent:input,refund:0n,protocol,tax};}
 const max=BPS-f-c-100n; if(max<0n)throw new RouteBlocked('INVALID_FEES','反狙击税上限不合法');
 const s=state.snipeBps>max?max:state.snipeBps;
 if(s<0n)throw new RouteBlocked('INVALID_FEES','反狙击税不合法');
 let spent=input,protocol=spent*f/BPS,tax=spent*c/BPS+spent*s/BPS;
 let out=amountOut(spent-protocol-tax,q,t);
 if(out>state.sellable){out=state.sellable;const net=amountIn(out,q,t);spent=ceilDiv(net*BPS,BPS-f-c-s);if(spent>input)spent=input;protocol=spent*f/BPS;tax=spent*c/BPS+spent*s/BPS;}
 return {out,spent,refund:input-spent,protocol,tax};
}
export function v2Quote(input:bigint,rin:bigint,rout:bigint,feeBps=25n){if(feeBps<0n||feeBps>=BPS)throw Error('Invalid pool fee');const weighted=input*(BPS-feeBps);return weighted*rout/(rin*BPS+weighted);}
export interface FlapCurveState {reserve:bigint;supply:bigint;r:bigint;h:bigint;k:bigint;threshold:bigint;quoteDecimals:number;feeBps:bigint;taxBps:bigint;}
export function flapReserve(s:FlapCurveState,supply:bigint){const denom=1000000000n*WAD+s.h-supply;if(denom<=0n||s.quoteDecimals>18)throw new RouteBlocked('INVALID_CURVE','Flap 曲线参数不可核实');return ceilDiv(ceilDiv(s.k*WAD,denom)-s.r,10n**BigInt(18-s.quoteDecimals));}
export function flapSpent(s:FlapCurveState,out:bigint,input:bigint){
 const net=flapReserve(s,s.supply+out)-flapReserve(s,s.supply);const gross=ceilDiv(net*BPS,BPS-s.feeBps-s.taxBps);
 if(s.supply+out>=s.threshold&&gross<input)return gross;
 return input;
}
export function flapVirtualSell(s:FlapCurveState,input:bigint){if(input<=0n||input>s.supply)throw new RouteBlocked('VIRTUAL_RESERVE_UNKNOWN','虚拟反向卖出的曲线储备不足');const gross=flapReserve(s,s.supply)-flapReserve(s,s.supply-input);if(gross<0n||s.feeBps+s.taxBps>=BPS)throw new RouteBlocked('INVALID_CURVE','虚拟曲线费用或储备不合法');const protocol=gross*s.feeBps/BPS,tax=gross*s.taxBps/BPS;return {out:gross-protocol-tax,spent:input,refund:0n,protocol,tax};}
export function units(raw:bigint,decimals:number){return Number(raw)/10**decimals;}
export function impact(side:'buy'|'sell',input:bigint,output:bigint,spot:number){if(!(spot>0)||!output)return 0;const execution=side==='buy'?Number(input)/Number(output):Number(output)/Number(input);return Math.max(0,(side==='buy'?execution/spot-1:1-execution/spot)*100);}
export function feeExcludedImpact(route:Route,side:'buy'|'sell',result:RouteQuote){
 const spot=result.spot;if(!(spot>0)||!Number.isFinite(spot))throw new RouteBlocked('IMPACT_UNKNOWN','无法核实边际价格，不能计算流动性冲击');
 let expected:number;
 if(['flap','four','pons-v2'].includes(route.kind)){
  if(side==='buy')expected=Number(result.spent-result.protocol-result.tax)/spot;
  else {const gross=Number(result.out+result.protocol+result.tax);const netRatio=Number(result.out)/gross;expected=Number(result.spent)*spot*netRatio;}
 }else{
  const lp=route.kind==='v2'?Number(route.fee??25)/10000:Number(route.kind==='v4'?route.key!.fee:route.fee!)/1e6;
  expected=Number(result.spent)*(1-lp)*(side==='buy'?1/spot:spot);
  if(route.state?.platform==='flap')expected*=1-Number(side==='buy'?route.state.buyTaxRate:route.state.sellTaxRate)/10000;
  if(route.kind==='v4')expected*=1-(Number(route.state?.hookFeeBps||0)+Number(route.state?.creatorTaxBps||0))/10000;
 }
 if(!(expected>0)||!Number.isFinite(expected))throw new RouteBlocked('IMPACT_UNKNOWN','无费用基准数量不可核实');
 return Math.max(0,(1-Number(result.out)/expected)*100);
}
