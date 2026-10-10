export const USD_SCALE=1000000n;
export const NATIVE_SCALE=1000000000000000000n;
export const ZERO_ADDRESS='0x0000000000000000000000000000000000000000';
export function usdInt(n:number):bigint {if(!Number.isFinite(n)||Math.abs(n)>1e12)throw Error('金额无效');return BigInt(Math.round(n*Number(USD_SCALE)));}
export function usdFloat(n:bigint):number {return Number(n)/Number(USD_SCALE);}
export function nativeUsd(raw:string|bigint,fx:number):number {if(!Number.isFinite(fx)||fx<=0)throw Error('报价币美元价格未知');return usdFloat(BigInt(raw)*usdInt(fx)/NATIVE_SCALE);}
export function usdNative(value:number,fx:number,ceil=false):bigint {if(value<0||!Number.isFinite(fx)||fx<=0)throw Error('金额或汇率无效');const a=usdInt(value)*NATIVE_SCALE,b=usdInt(fx);return (a+(ceil?b-1n:0n))/b;}
export function allocateUsd(total:number,part:bigint,whole:bigint):number {if(part<0n||whole<=0n||part>whole)throw Error('成本分配无效');return usdFloat(usdInt(total)*part/whole);}
export function percentRaw(raw:string|bigint,pct:number):bigint {if(!Number.isFinite(pct)||pct<0||pct>100)throw Error('卖出比例必须在0到100之间');return BigInt(raw)*BigInt(Math.round(pct*10000))/1000000n;}
export function validAddress(value:unknown):string {if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))throw Error('请输入完整的代币合约地址');return value.toLowerCase();}
export function beijingDay(at=Date.now()):string {return new Date(at+8*3600000).toISOString().slice(0,10);}
export function positive(value:unknown,label:string,max=1e8):number {if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>max)throw Error(label+'无效');return value;}
