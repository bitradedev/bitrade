import type {Address} from 'viem';

export interface QuoteReference {block:number;quoteDecimals:number;nativePerQuote:number;capturedAt:number;}
type ReadResult=Omit<QuoteReference,'capturedAt'>;
/** Display/signal currency references, never executable order quotes. A missing
 * reference keeps the actual receipt but supplies no invented USD price.
 * One background probe per chain prevents unsupported quote assets from
 * serially blocking every unrelated live receipt. */
export class QuoteReferences {
 private values=new Map<Address,QuoteReference&{mono:number}>();
 private failures=new Map<Address,{until:number;reason:string}>();
 private pending=new Map<Address,number>();private active?:Address;private closed=false;private revision=0;
 constructor(private load:(quote:Address,block:number)=>Promise<ReadResult>,private mono=()=>performance.now(),private wall=()=>Date.now()){}
 read(quote:Address,block:number):{value?:QuoteReference;reason?:string}{
  if(this.closed)return {reason:'报价币参考读取已停止'};
  const now=this.mono(),cached=this.values.get(quote),age=cached?now-cached.mono:Infinity;
  const usable=cached&&cached.block<=block&&age>=0&&age<15000;
  if(!usable||age>=5000)this.request(quote,block);
  if(usable){const {mono,...value}=cached;return {value};}
  const failure=this.failures.get(quote);
  return {reason:failure&&now<failure.until?`报价币参考尚未核实，后台冷却后重试：${failure.reason}`:'报价币参考尚未核实，等待后台真实读取；保留成交数量但不补美元价格'};
 }
 private request(quote:Address,block:number){
  if(this.active===quote||this.mono()<(this.failures.get(quote)?.until??-Infinity))return;
  const previous=this.pending.get(quote);if(previous!==undefined)this.pending.set(quote,Math.max(previous,block));
  else if(this.pending.size<32)this.pending.set(quote,block);
  void this.pump();
 }
 private async pump(){
  if(this.active||this.closed)return;
  while(this.pending.size&&!this.closed){const [quote,block]=this.pending.entries().next().value!,revision=this.revision;this.pending.delete(quote);this.active=quote;
   try{const result=await this.load(quote,block);
    if(this.closed||revision!==this.revision)continue;
    if(result.block!==block||!Number.isSafeInteger(block)||block<0||!Number.isInteger(result.quoteDecimals)||result.quoteDecimals<0||result.quoteDecimals>36||!(result.nativePerQuote>0)||!Number.isFinite(result.nativePerQuote))throw Error('报价币参考区块、精度或真实价格无效');
    const previous=this.values.get(quote);if(!previous||previous.block<=block)this.values.set(quote,{...result,capturedAt:this.wall(),mono:this.mono()});
    this.failures.delete(quote);this.cap(this.values,100);
   }catch(error){if(!this.closed&&revision===this.revision){this.failures.set(quote,{until:this.mono()+5000,reason:(error instanceof Error?error.message:String(error)).slice(0,250)});this.cap(this.failures,100);}}
   finally{this.active=undefined;}
  }
 }
 private cap<T>(map:Map<Address,T>,limit:number){while(map.size>limit)map.delete(map.keys().next().value!);}
 invalidate(){this.revision++;this.values.clear();this.failures.clear();this.pending.clear();}
 close(){this.closed=true;this.invalidate();}
}
