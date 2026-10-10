import type { Address } from 'viem';
import type { Chain, Market, QuoteRequest } from '../../shared/domain.js';
export type { Chain } from '../../shared/domain.js';

export type Wallet = { address:string; name:string };
export type Audit = (kind:string,message:string,details?:unknown)=>void;
export interface GatewayOptions {dataDir?:string;proxy?:string;wallets?:Partial<Record<Chain,Wallet[]>>;onAudit?:Audit;}
export const ORDINARY_RECIPIENT = '0x000000000000000000000000000000000000c0de' as Address;
export const ZERO = '0x0000000000000000000000000000000000000000' as Address;
export const CHAIN_CONFIG = {
  bsc:{id:56,http:'https://bsc-rpc.publicnode.com',ws:'wss://bsc-rpc.publicnode.com',wrapped:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',v2Factory:'0xca143ce32fe78f1f7019d7d551a6402fc5350c73',v3Factory:'0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',v3Quoter:'0xb048bbc1ee6b733fffcfb9e9cef7375518e25997'},
  robinhood:{id:4663,http:'https://rpc.mainnet.chain.robinhood.com',wrapped:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',v3Factory:'0x1f7d7550b1b028f7571e69a784071f0205fd2efa',v3Quoter:'0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',v4Manager:'0x8366a39cc670b4001a1121b8f6a443a643e40951',v4Quoter:'0x8dc178efb8111bb0973dd9d722ebeff267c98f94',v4State:'0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'},
} as const;
export const FLAP = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0' as Address;
export const FOUR_HELPER = '0xf251f83e40a78868fcfa3fa4599dad6494e46034' as Address;
export const FOUR_MANAGER = '0x5c952063c7fc8610ffdb798152d69f0b9550762b' as Address;
export const PONS_V2 = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' as Address;
export const PONS_V1 = ['0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb','0x0c37a24f5d23a486fa692d1500881d698b1f77a4'] as Address[];
export interface PoolKey {currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address;}
export interface Route {kind:'flap'|'four'|'pons-v2'|'v2'|'v3'|'v4';token:Address;quote:Address;pool?:Address;factory?:Address;curve?:Address;key?:PoolKey;fee?:number;state?:Record<string,any>;}
export interface RouteQuote {out:bigint;spent:bigint;refund:bigint;protocol:bigint;tax:bigint;spot:number;notes:string[];impactPct?:number;impactQuality?:'verified'|'estimated';}
export interface GasContext {gasUsedRaw:string;gasPriceRaw:string;sampleBlock:number;sampleTransaction:string;sourceFeeFrozenAt:number;}
export interface Snapshot {chain:Chain;token:string;block:number;blockHash:string;chainTime:number;capturedAt:number;market:Market;gasContext?:GasContext;}
export interface RepriceRequest extends Omit<QuoteRequest,'chain'|'token'|'block'> {}
export class RouteBlocked extends Error {constructor(public readonly code:string,message:string){super(message);this.name='RouteBlocked';}}
export function address(value:string):Address {if(!/^0x[0-9a-f]{40}$/i.test(value))throw new RouteBlocked('BAD_ADDRESS','地址格式不正确');return value.toLowerCase() as Address;}
export function raw(value:string|undefined):bigint {if(!value||!/^\d{1,78}$/.test(value)||BigInt(value)<=0n||BigInt(value)>=(1n<<256n))throw new RouteBlocked('BAD_AMOUNT','数量必须是正整数最小单位');return BigInt(value);}
export function capMap<K,V>(map:Map<K,V>,max:number){while(map.size>max)map.delete(map.keys().next().value!);}
