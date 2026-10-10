import { encodeAbiParameters,keccak256, type Address } from 'viem';
import type { Side } from '../../shared/domain.js';
import { ERC20,FLAP_ABI,FOUR_ABI,PONS_V1_ABI,PONS_V2_ABI,V2_ABI,V3_ABI,V4_ABI } from './abi.js';
import { CHAIN_CONFIG,FLAP,FOUR_HELPER,FOUR_MANAGER,PONS_V1,PONS_V2,ZERO,ORDINARY_RECIPIENT,RouteBlocked,address,type Route,type RouteQuote,type PoolKey,capMap } from './types.js';
import type { ReadRpc } from './rpc.js';
import { BPS,WAD,flapReserve,flapSpent,flapVirtualSell,quotePons,units,v2Quote,feeExcludedImpact } from './math.js';

export function poolId(key:PoolKey){return keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]));}
export class Venues {
 private decimalsCache=new Map<string,number>();private conversionCache=new Map<string,{at:number;route:Route}>();
 private ponsFees=new Map<string,{block:number;fee:bigint;creator:bigint}>();private revision=0;
 private poolAssets=new Map<string,{block:number;token0:Address;token1:Address}>();
 constructor(readonly rpc:ReadRpc){}
 invalidate(){this.revision++;this.decimalsCache.clear();this.conversionCache.clear();this.ponsFees.clear();this.poolAssets.clear();}
 private async curveFees(curve:Address,block:number){const cached=this.ponsFees.get(curve);if(cached&&block>=cached.block)return cached;const revision=this.revision;
  // Official curve fee terms are immutable; the proof's first block is kept.
  // Dynamic and recipient-specific reads below never use this cache.
  const [fee,creator]=await Promise.all([this.rpc.read<bigint>(curve,PONS_V2_ABI,'feeBps',[],block),this.rpc.read<bigint>(curve,PONS_V2_ABI,'creatorTaxBps',[],block)]);
  if(revision!==this.revision)throw new RouteBlocked('QUOTE_REORG','读取曲线费率期间发生重组');if(fee<0n||creator<0n||fee+creator>=BPS)throw new RouteBlocked('INVALID_FEES','Pons 曲线费率不可核实');
  const result={block,fee,creator};this.ponsFees.set(curve,result);capMap(this.ponsFees,500);return result;
 }
 async decimals(token:Address,block?:number){if(token===ZERO)return 18;let d=this.decimalsCache.get(token);if(d===undefined){d=Number(await this.rpc.read(token,ERC20,'decimals',[],block));if(!Number.isInteger(d)||d<0||d>36)throw new RouteBlocked('DECIMALS_UNKNOWN','代币精度不可核实');this.decimalsCache.set(token,d);capMap(this.decimalsCache,2000);}return d;}
 async resolve(token:Address,block:number,poolHint?:string):Promise<Route>{
  if(this.rpc.chain==='bsc'){
   const s=await this.rpc.read<any>(FLAP,FLAP_ABI,'getTokenV8Safe',[token],block).catch(()=>null);
   if(s&&Number(s.status)>0){
    if(![1,4].includes(Number(s.status)))throw new RouteBlocked('FLAP_CLOSED',`Flap 当前状态 ${s.status} 不可交易`);
    const quote=address(s.quoteTokenAddress);
    if(Number(s.status)===4){const route=await this.pool(token,quote,address(s.pool),block);route.state={...s,platform:'flap'};return route;}
    const fee=await this.rpc.read<any>(FLAP,FLAP_ABI,'getFeeRate',[],block);return {kind:'flap',token,quote,state:{...s,buyFeeBps:fee[0],sellFeeBps:fee[1]}};
   }
   const f=await this.rpc.read<any>(FOUR_HELPER,FOUR_ABI,'getTokenInfo',[token],block).catch(()=>null);
   if(f&&Number(f[0])>0&&f[1]!==ZERO){
    const version=Number(f[0]),quote=address(f[2]);const ti=version===2?await this.rpc.read<any>(address(f[1]),FOUR_ABI,'_tokenInfos',[token],block):null;
    const creatorType=ti?Number((ti.template>>10n)&63n):0;
    let buyTax=0n,sellTax=0n;if([8,9].includes(creatorType)){[buyTax,sellTax]=await Promise.all([this.rpc.read<bigint>(token,FOUR_ABI,'feeRateBuy',[],block),this.rpc.read<bigint>(token,FOUR_ABI,'feeRateSell',[],block)]);buyTax*=100n;sellTax*=100n;}else if(creatorType===5){buyTax=sellTax=await this.rpc.read<bigint>(token,FOUR_ABI,'feeRate',[],block);}else if(![0,1,2,3,4,6,7].includes(creatorType))throw new RouteBlocked('FOUR_TEMPLATE_UNKNOWN','Four 代币模板尚未核实');
    if(f[11]){const r=await this.dex(token,quote,block,poolHint);r.state={buyTaxRate:buyTax,sellTaxRate:sellTax,platform:'four'};return r;}
    return {kind:'four',token,quote,factory:address(f[1]),state:{version,lastPrice:f[3],feeBps:f[4],minFee:f[5],launchTime:f[6],offers:f[7],buyTaxRate:buyTax,sellTaxRate:sellTax,creatorType}};
   }
  }else{
   const s=await this.rpc.read<any>(PONS_V2,PONS_V2_ABI,'getLaunchedToken',[token],block).catch(()=>null);
   if(s?.exists){const quote=address(s.pairToken);if(s.phase===1)throw new RouteBlocked('PONS_SWEPT','Pons 已清空曲线，等待创建毕业池');if(s.phase===3)throw new RouteBlocked('PONS_RESCUED','Pons 此币已进入救援状态');
    if(s.phase===0)return {kind:'pons-v2',token,quote,curve:address(s.curve),factory:PONS_V2,state:s};
    if(s.phase!==2)throw new RouteBlocked('PONS_PHASE_UNKNOWN','Pons 阶段不可核实');
    const [hook,manager]=await Promise.all([this.rpc.read<string>(PONS_V2,PONS_V2_ABI,'memeHook',[],block),this.rpc.read<string>(PONS_V2,PONS_V2_ABI,'poolManager',[],block)]);
    if(address(manager)!==CHAIN_CONFIG.robinhood.v4Manager)throw new RouteBlocked('V4_MANAGER_UNKNOWN','Pons 使用的 V4 PoolManager 未接入');
    const [currency0,currency1]=[token,quote].sort() as Address[];const key={currency0,currency1,fee:Number(s.poolFee),tickSpacing:Number(s.tickSpacing),hooks:address(hook)};
    const info=await this.rpc.read<any>(key.hooks,PONS_V2_ABI,'launches',[poolId(key)],block);
    if(!info[0]||address(info[2])!==token||address(info[3])!==quote)throw new RouteBlocked('V4_HOOK_UNKNOWN','毕业池 Hook 信息无法核实');
    return {kind:'v4',token,quote,factory:PONS_V2,key,state:{...s,hookFeeBps:BigInt(info[10]),buyTaxRate:BigInt(info[7]),sellTaxRate:BigInt(info[7]),platform:'pons-v2'}};
   }
   for(const factory of PONS_V1){const s=await this.rpc.read<any>(factory,PONS_V1_ABI,'getLaunchedToken',[token],block).catch(()=>null);if(s?.exists){const pool=address(await this.rpc.read<string>(token,PONS_V1_ABI,'liquidityPool',[],block));const route=await this.pool(token,address(s.pairedToken),pool,block);const phase=await this.rpc.read<any>(factory,PONS_V1_ABI,'graduationStatus',[token],block);route.factory=factory;route.state={...s,platform:'pons-v1',graduated:phase[2]};return route;}}
  }
  return this.dex(token,address(CHAIN_CONFIG[this.rpc.chain].wrapped),block,poolHint);
 }
 async pool(token:Address,quote:Address,pool:Address,block:number):Promise<Route>{
  const revision=this.revision;
  if(pool===ZERO)throw new RouteBlocked('POOL_UNKNOWN','尚未找到真实池');
  const [factory,t0,t1]=await Promise.all([this.rpc.read<string>(pool,V2_ABI,'factory',[],block),this.rpc.read<string>(pool,V2_ABI,'token0',[],block),this.rpc.read<string>(pool,V2_ABI,'token1',[],block)]);
  const wrapped=address(CHAIN_CONFIG[this.rpc.chain].wrapped),other=quote===ZERO?wrapped:quote;
  if(![t0.toLowerCase(),t1.toLowerCase()].includes(token)||![t0.toLowerCase(),t1.toLowerCase()].includes(other))throw new RouteBlocked('POOL_ASSETS_UNKNOWN','池中的交易资产不匹配');
  const cfg=CHAIN_CONFIG[this.rpc.chain];if(this.rpc.chain==='bsc'&&address(factory)===CHAIN_CONFIG.bsc.v2Factory){const expected=await this.rpc.read<string>(address(factory),V2_ABI,'getPair',[token,other],block);if(address(expected)!==pool)throw new RouteBlocked('POOL_NOT_CANONICAL','V2 池与官方工厂不一致');this.rememberPoolAssets(pool,t0,t1,block,revision);return {kind:'v2',token,quote,pool,fee:25};}
  if(address(factory)!==cfg.v3Factory)throw new RouteBlocked('FACTORY_UNSUPPORTED','池工厂未核实或尚未支持');
  const fee=Number(await this.rpc.read(pool,V3_ABI,'fee',[],block));const expected=await this.rpc.read<string>(address(factory),V3_ABI,'getPool',[token,other,fee],block);if(address(expected)!==pool)throw new RouteBlocked('POOL_NOT_CANONICAL','V3 池与官方工厂不一致');
  this.rememberPoolAssets(pool,t0,t1,block,revision);return {kind:'v3',token,quote,pool,fee};
 }
 private rememberPoolAssets(pool:Address,t0:string,t1:string,block:number,revision:number){if(revision!==this.revision)throw new RouteBlocked('QUOTE_REORG','核实池资产期间发生重组');const old=this.poolAssets.get(pool);if(!old||block<old.block)this.poolAssets.set(pool,{block,token0:address(t0),token1:address(t1)});capMap(this.poolAssets,300);}
 async poolToken0(route:Route,block:number):Promise<Address>{
  if(!route.pool||!['v2','v3'].includes(route.kind))throw new RouteBlocked('POOL_UNKNOWN','没有已核实的 V2/V3 池');
  const known=this.poolAssets.get(route.pool),other=route.quote===ZERO?address(CHAIN_CONFIG[this.rpc.chain].wrapped):route.quote;
  if(known&&block>=known.block&&[known.token0,known.token1].includes(route.token)&&[known.token0,known.token1].includes(other))return known.token0;
  // A lone getter is not a canonical pool proof. Before the proof block or
  // after invalidation, retain the original exact-block read without caching.
  const t0=address(await this.rpc.read<string>(route.pool,V2_ABI,'token0',[],block));if(t0!==route.token&&t0!==other)throw new RouteBlocked('POOL_ASSETS_UNKNOWN','池的 token0 与已核实交易资产不匹配');return t0;
 }
 async dex(token:Address,quote:Address,block:number,hint?:string):Promise<Route>{
  if(hint&&/^0x[0-9a-f]{40}$/i.test(hint)){try{return await this.pool(token,quote,address(hint),block);}catch(e){if(e instanceof RouteBlocked&&e.code==='FACTORY_UNSUPPORTED')throw e;}}
  const cfg=CHAIN_CONFIG[this.rpc.chain],other=quote===ZERO?address(cfg.wrapped):quote;
  if(this.rpc.chain==='bsc'){const p=address(await this.rpc.read<string>(address(CHAIN_CONFIG.bsc.v2Factory),V2_ABI,'getPair',[token,other],block));if(p!==ZERO)return this.pool(token,quote,p,block);}
  for(const fee of [10000,2500,3000,500,100]){const p=await this.rpc.read<string>(address(cfg.v3Factory),V3_ABI,'getPool',[token,other,fee],block).catch(()=>ZERO);if(address(p)!==ZERO)return this.pool(token,quote,address(p),block);}
  throw new RouteBlocked('ROUTE_UNKNOWN','没有核实可执行的原生币交易路线');
 }
 async conversion(quote:Address,block:number):Promise<Route|null>{
  const native=address(CHAIN_CONFIG[this.rpc.chain].wrapped);if(quote===ZERO||quote===native)return null;
  const cached=this.conversionCache.get(quote);if(cached&&block-cached.at<20&&block>=cached.at)return cached.route;
  const route=await this.dex(quote,native,block);this.conversionCache.set(quote,{route,at:block});capMap(this.conversionCache,100);return route;
 }
 async spot(route:Route,block:number){
  if(route.kind==='flap')return Number(route.state!.price)/1e18*10**(await this.decimals(route.quote,block)-18);
  if(route.kind==='four')return Number(route.state!.lastPrice)/1e18;
  if(route.kind==='pons-v2'){const [q,t]=await this.rpc.read<any>(route.curve!,PONS_V2_ABI,'getReserves',[],block);if(t<=0n)throw new RouteBlocked('EMPTY_RESERVES','价格储备为空');return Number(q)/Number(t);}
  if(route.kind==='v4'){const slot=await this.rpc.read<any>(address(CHAIN_CONFIG.robinhood.v4State),V4_ABI,'getSlot0',[poolId(route.key!)],block);const rate=(Number(slot[0])/2**96)**2;return route.key!.currency0===route.token?rate:1/rate;}
  const token0=await this.poolToken0(route,block)===route.token;
  if(route.kind==='v2'){const reserves=await this.rpc.read<any>(route.pool!,V2_ABI,'getReserves',[],block);const tr=BigInt(reserves[token0?0:1]),qr=BigInt(reserves[token0?1:0]);if(!tr||!qr)throw new RouteBlocked('EMPTY_RESERVES','池储备为空');return Number(qr)/Number(tr);}
  const slot=await this.rpc.read<any>(route.pool!,V3_ABI,'slot0',[],block);const rate=(Number(slot[0])/2**96)**2;return token0?rate:1/rate;
 }
 async quote(route:Route,side:Side,input:bigint,block:number,recipient:Address=ORDINARY_RECIPIENT):Promise<RouteQuote>{const result=await this.quoteCore(route,side,input,block,recipient);return {...result,impactPct:feeExcludedImpact(route,side,result),impactQuality:route.kind==='v4'||route.state?.virtualPreview?'estimated':'verified'};}
 private async quoteCore(route:Route,side:Side,input:bigint,block:number,recipient:Address=ORDINARY_RECIPIENT):Promise<RouteQuote>{
  const read=(contract:Address,abi:any,name:string,args:readonly unknown[]=[])=>this.rpc.read<any>(contract,abi,name,args,block,recipient);
  if(route.kind==='pons-v2'){
   const names=['getReserves','sellableTokens','readyToGraduate','graduated'];
   const [values,fees,s]=await Promise.all([Promise.all(names.map(n=>read(route.curve!,PONS_V2_ABI,n))),this.curveFees(route.curve!,block),side==='buy'?read(route.curve!,PONS_V2_ABI,'currentSnipeTaxBps',[recipient]):Promise.resolve(0n)]);
   const [[q,t],sellable,ready,graduated]=values,{fee:f,creator:c}=fees;
   const result=quotePons({quoteReserve:q,tokenReserve:t,sellable,feeBps:f,creatorTaxBps:c,snipeBps:s,ready,graduated},side,input);
   return {...result,spot:Number(q)/Number(t),notes:[`独立模拟收款地址 ${recipient}`,side==='buy'?`当前反狙击税 ${s} bps（按实际收款地址读取）`:'卖出不适用反狙击税；未查询买入税率',`创建时固定的协议费/创作者税已在区块 ${fees.block} 实链核实；动态储备与毕业状态按报价区块读取`,'储备包含 phantom，使用 getReserves；输出已扣协议费和税']};
  }
  if(route.kind==='flap'){
   const s=route.state!,qDecimals=await this.decimals(route.quote,block);const fee=BigInt(side==='buy'?s.buyFeeBps:s.sellFeeBps),tax=BigInt(side==='buy'?s.buyTaxRate:s.sellTaxRate);
   if(side==='sell'&&s.virtualPreview){const cs={reserve:s.reserve,supply:s.circulatingSupply,r:s.r,h:s.h,k:s.k,threshold:s.dexSupplyThresh,quoteDecimals:qDecimals,feeBps:fee,taxBps:tax};return {...flapVirtualSell(cs,input),spot:Number(s.price)/1e18*10**qDecimals/1e18,notes:['虚拟买入后即时反向预览：按该确切买入造成的曲线状态变化计算；尚未发生链上买入，标为 estimated','未检查模拟账户真实余额、授权或任何私钥']};}
   const out=BigInt(await read(FLAP,FLAP_ABI,'quoteExactInput',[{inputToken:side==='buy'?route.quote:route.token,outputToken:side==='buy'?route.token:route.quote,inputAmount:input}]));
   if(!out)throw new RouteBlocked('ZERO_QUOTE','Flap 返回零数量，可能受配额或阶段限制');
   const cs={reserve:s.reserve,supply:s.circulatingSupply,r:s.r,h:s.h,k:s.k,threshold:s.dexSupplyThresh,quoteDecimals:qDecimals,feeBps:fee,taxBps:tax};
   const spent=side==='buy'?flapSpent(cs,out,input):input;
   const gross=side==='buy'?spent:flapReserve(cs,cs.supply)-flapReserve(cs,cs.supply-input);
   if(fee+tax>=BPS||gross<0n)throw new RouteBlocked('INVALID_FEES','Flap 费用或储备无法核实');
   return {out,spent,refund:input-spent,protocol:gross*fee/BPS,tax:gross*tax/BPS,spot:Number(s.price)/1e18*10**qDecimals/1e18,notes:['Flap quoteExactInput 使用 eth_call，并显式指定普通模拟地址','税与协议费已在链上报价内；退款按曲线阈值计算']};
  }
  if(route.kind==='four'){
   const s=route.state!,taxBps=BigInt(side==='buy'?s.buyTaxRate:s.sellTaxRate);
   if(side==='buy'){let funds=input;for(let attempt=0;attempt<5;attempt++){const r=await read(FOUR_HELPER,FOUR_ABI,'tryBuy',[route.token,0n,funds]);const out=BigInt(r[2]),gross=BigInt(r[3]),baseProtocol=BigInt(r[4]);if(address(r[1])!==route.quote)throw new RouteBlocked('QUOTE_CHANGED','Four 报价币已变化');
    const tax=gross*taxBps/BPS,suggested=BigInt(route.quote===ZERO?r[5]:r[6]);const calculated=gross+baseProtocol+tax;const spent=suggested>calculated?suggested:calculated,protocol=baseProtocol+(spent-calculated);
    if(spent<=input&&out>0n)return {out,spent,refund:input-spent,protocol,tax,spot:Number(s.lastPrice)/1e18,notes:['Helper3 tryBuy 按含税总预算重新 eth_call；不缩放此前的代币报价','TaxToken8/9 独立税与 amountMsgValue/amountApproval 核对，取足额成本；协议费用中包含额外反狙击/待支付启动费']};
    if(spent<=0n||funds<=1n)break;const next=funds*input/spent;if(next>=funds)break;funds=next;
   }throw new RouteBlocked('FOUR_BUDGET_OVERFLOW','费用或最小交易费超出预算，无法得到含税报价');
   }
   if(input%1000000000n!==0n)throw new RouteBlocked('FOUR_AMOUNT_PRECISION','Four 内盘数量须对齐 1e9 最小单位；请按协议精度调整卖出量');
   const r=await read(FOUR_HELPER,FOUR_ABI,'trySell',[route.token,input]);if(address(r[1])!==route.quote)throw new RouteBlocked('QUOTE_CHANGED','Four 报价币已变化');const out=BigInt(r[2]),protocol=BigInt(r[3]);const gross=taxBps?((out+protocol)*BPS/(BPS-taxBps)):out+protocol;
   return {out,spent:input,refund:0n,protocol,tax:gross-out-protocol,spot:Number(s.lastPrice)/1e18,notes:['trySell 的 funds 已扣协议费和 TaxToken8/9 卖出税，明细不能再扣一次']};
  }
  // A transferred token can liquidate its accrued fees while selling. A quoter
  // does not exercise that transfer, so fail closed instead of inventing a fill.
  if(['v2','v3'].includes(route.kind)&&(BigInt(route.state?.buyTaxRate||0)||BigInt(route.state?.sellTaxRate||0)))throw new RouteBlocked('TRANSFER_TAX_UNVERIFIED','外盘转账税及自动税款清算尚未核实，拒绝模拟成交');
  if(route.kind==='v2'){
   const [reserves,t0]=await Promise.all([read(route.pool!,V2_ABI,'getReserves'),read(route.pool!,V2_ABI,'token0')]);const token0=address(t0)===route.token;const tr=BigInt(reserves[token0?0:1]),qr=BigInt(reserves[token0?1:0]);const rin=side==='buy'?qr:tr,rout=side==='buy'?tr:qr;
   return {out:v2Quote(input,rin,rout),spent:input,refund:0n,protocol:side==='buy'?input*25n/BPS:(input*25n/BPS)*qr/tr,tax:0n,spot:Number(qr)/Number(tr),notes:['官方 Pancake V2 工厂验证，恒定乘积整数报价，0.25% LP 费已包含']};
  }
  if(route.kind==='v3'){
   if(route.state?.platform==='pons-v1'&&side==='buy'&&block<=Number(route.state.restrictionsEndBlock))throw new RouteBlocked('PONS_V1_RESTRICTIONS','Pons V1 尚在买入限制期；虚拟累计钱包配额无法从链上核实');
   const quote=route.quote===ZERO?address(CHAIN_CONFIG[this.rpc.chain].wrapped):route.quote;const [result,slot,t0]=await Promise.all([read(address(CHAIN_CONFIG[this.rpc.chain].v3Quoter),V3_ABI,'quoteExactInputSingle',[{tokenIn:side==='buy'?quote:route.token,tokenOut:side==='buy'?route.token:quote,amountIn:input,fee:route.fee!,sqrtPriceLimitX96:0n}]),read(route.pool!,V3_ABI,'slot0'),read(route.pool!,V3_ABI,'token0')]);
   const rate=(Number(slot[0])/2**96)**2,spot=address(t0)===route.token?rate:1/rate;
   if(BigInt(result[1])<=4295128740n||BigInt(result[1])>=1461446703485210103287273052203988822378723970341n)throw new RouteBlocked('V3_PARTIAL_UNVERIFIED','V3 报价触及流动性边界，无法核实全额输入与退款，暂停模拟成交');
   return {out:BigInt(result[0]),spent:input,refund:0n,protocol:side==='buy'?input*BigInt(route.fee!)/1000000n:BigInt(Math.floor(Number(input)*spot*route.fee!/1e6)),tax:0n,spot,notes:['官方 V3 QuoterV2 eth_call，跨 tick 的价格冲击和 LP 费已包含']};
  }
  if(route.kind==='v4'){
   const cfg=CHAIN_CONFIG.robinhood,key=route.key!;const id=poolId(key);const inputCurrency=side==='buy'?route.quote:route.token;
   if(input>=1n<<128n)throw new RouteBlocked('V4_AMOUNT_OVERFLOW','V4 报价数量超过 uint128');
   const [result,slot]=await Promise.all([read(address(cfg.v4Quoter),V4_ABI,'quoteExactInputSingle',[{poolKey:key,zeroForOne:key.currency0===inputCurrency,exactAmount:input,hookData:'0x'}]),read(address(cfg.v4State),V4_ABI,'getSlot0',[id])]);
   const out=BigInt(result[0]),rate=(Number(slot[0])/2**96)**2,spot=key.currency0===route.token?rate:1/rate;
   const h=BigInt(route.state?.hookFeeBps||0),c=BigInt(route.state?.creatorTaxBps||0);const gross=out*BPS/(BPS-h-c);
   const outputQuoteValue=side==='buy'?BigInt(Math.floor(Number(gross)*spot)):gross;
   const lp=side==='buy'?input*BigInt(key.fee)/1000000n:BigInt(Math.floor(Number(input)*spot*key.fee/1e6));
   return {out,spent:input,refund:0n,protocol:lp+outputQuoteValue*h/BPS,tax:outputQuoteValue*c/BPS,spot,notes:['V4 Quoter 的返回数量已包含 LP 费和 Pons afterSwap Hook 费用，不再重复扣除','Hook 与创作者税从未指定一侧（exact-input 的输出侧）扣除；费用美元拆分是估计归因']};
  }
  throw new RouteBlocked('UNSUPPORTED','该协议尚未支持');
 }
}
