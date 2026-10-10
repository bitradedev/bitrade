import {randomUUID} from 'node:crypto';
import {RouteBlocked} from './types.js';

interface ReadSocket {
 readyState:number;
 send(data:string):void;
 addEventListener(type:string,listener:(event:any)=>void):void;
 removeEventListener(type:string,listener:(event:any)=>void):void;
}
export interface ConfirmedHeader {number:number;hash:string;parentHash:string;time:number;}
const blockNumber=(value:unknown):number|undefined=>{
 if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))return;
 const number=Number(BigInt(value));return Number.isSafeInteger(number)?number:undefined;
};
const isHash=(value:unknown):value is string=>typeof value==='string'&&/^0x[0-9a-f]{64}$/i.test(value);

/** Subscription headers only prove the time/hash of their exact fork. They
 * never replace full block reads used for gas sampling or executable quotes. */
export class ConfirmedBscHeaders {
 private rows=new Map<number,ConfirmedHeader>();
 observe(value:any){
  const number=blockNumber(value?.number),seconds=blockNumber(value?.timestamp);
  if(number===undefined||seconds===undefined||seconds<=0||!Number.isSafeInteger(seconds*1000)||!isHash(value?.hash)||!isHash(value?.parentHash))return;
  this.rows.set(number,{number,hash:value.hash.toLowerCase(),parentHash:value.parentHash.toLowerCase(),time:seconds*1000});
  while(this.rows.size>256)this.rows.delete(this.rows.keys().next().value!);
 }
 match(number:number,hash:unknown){const row=this.rows.get(number);return isHash(hash)&&row?.hash===hash.toLowerCase()?{...row}:undefined;}
 invalidate(from=0){for(const number of this.rows.keys())if(number>=from)this.rows.delete(number);}
}

/** The caller supplies the feed socket only after its BSC chain-id handshake.
 * ReadRpc owns pacing and fallback. This narrow helper has no arbitrary method
 * parameter and cannot submit, sign or authorize a transaction. */
export function readBscBlockReceipts(socket:ReadSocket|undefined,block:string,timeoutMs=8000):Promise<any[]> {
 if(blockNumber(block)===undefined)return Promise.reject(new RouteBlocked('INVALID_BLOCK','区块回执必须绑定实际区块号'));
 if(!socket||socket.readyState!==1)return Promise.reject(new RouteBlocked('WS_UNAVAILABLE','BSC 已核实订阅连接尚未就绪'));
 return new Promise((resolve,reject)=>{
  const id='paper:block-receipts:'+randomUUID();let done=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(error?:unknown,result?:any[])=>{if(done)return;done=true;if(timer)clearTimeout(timer);socket.removeEventListener('message',message);socket.removeEventListener('close',closed);socket.removeEventListener('error',closed);error?reject(error):resolve(result!);};
  const closed=()=>finish(new RouteBlocked('WS_UNAVAILABLE','BSC 回执只读连接已断开'));
  const message=(event:any)=>{let body:any;try{const data=String(event.data);if(Buffer.byteLength(data)>16*1024*1024)return;body=JSON.parse(data);}catch{return;}
   if(body?.id!==id)return;
   if(body.jsonrpc!=='2.0')return finish(new RouteBlocked('RECEIPTS_INVALID','区块回执响应格式无效'));
   if(body.error)return finish(new RouteBlocked('RPC_ERROR',String(body.error.message??'区块回执读取失败').slice(0,250)));
   if(!Array.isArray(body.result))return finish(new RouteBlocked('RECEIPTS_INVALID','区块回执响应无效'));
   finish(undefined,body.result);
  };
  socket.addEventListener('message',message);socket.addEventListener('close',closed);socket.addEventListener('error',closed);
  timer=setTimeout(()=>finish(new RouteBlocked('RPC_DEADLINE','BSC 订阅连接回执读取超时')),timeoutMs);
  try{socket.send(JSON.stringify({jsonrpc:'2.0',id,method:'eth_getBlockReceipts',params:[block]}));}catch(error){finish(error);}
 });
}
