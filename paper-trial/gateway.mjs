import {StateStreamReceiver} from '../paper-terminal/dist/shared/state-stream.js';

// This adapter has a single fixed source and a single read-only quote route.
// It cannot invoke orders, swap, signing or transaction-broadcast routes.
export class SharedGateway {
  state=null;receivedAt=0;lastError='正在连接原终端';connected=false;controller;stopping=false;epochs={bsc:0,robinhood:0};
  constructor(base='http://127.0.0.1:8790',onGeneration=()=>{},onCoverage=onGeneration) {
    if(base!=='http://127.0.0.1:8790')throw Error('仅允许已有的本机只读行情源');
    this.base=base;this.onGeneration=onGeneration;this.onCoverage=onCoverage;
  }
  statuses(){return (this.state?.chains??[]).map(s=>({...s,connected:s.connected&&this.connected&&Date.now()-this.receivedAt<5000}));}
  markets(){return this.state?.markets??[];}
  getMarket(chain,token){return this.markets().find(m=>m.chain===chain&&m.address.toLowerCase()===token.toLowerCase());}
  async quote(q){
    if(!['bsc','robinhood'].includes(q.chain)||!/^0x[0-9a-f]{40}$/i.test(q.token)||!/^0x[0-9a-f]{40}$/i.test(q.recipient)||!['buy','sell'].includes(q.side))throw Error('只读报价参数无效');
    const amount=q.side==='buy'?q.nativeAmountRaw:q.tokenAmountRaw;
    if(!/^\d{1,78}$/.test(amount)||BigInt(amount)<=0n||!Number.isSafeInteger(q.block))throw Error('只读报价数量或区块无效');
    const csrf=this.state?.csrf,generation=csrf,epoch=this.epochs[q.chain];
    if(!csrf||!this.statuses().find(s=>s.chain===q.chain)?.connected)throw Error('共享行情连接过期，停止报价');
    const params=new URLSearchParams({chain:q.chain,token:q.token,side:q.side,recipient:q.recipient,block:String(q.block),[q.side==='buy'?'nativeAmountRaw':'tokenAmountRaw']:amount});
    const response=await fetch(this.base+'/api/paper/quote?'+params,{headers:{'x-csrf-token':csrf},signal:AbortSignal.timeout(4500)});
    const value=await response.json();
    if(!response.ok)throw Error(value.error??'只读报价失败');
    if(this.state?.csrf!==generation||this.epochs[q.chain]!==epoch)throw Error('此链行情重启或重组，旧报价失效');
    return value.quote;
  }
  async start(){
    while(!this.stopping){
      this.controller=new AbortController();const receiver=new StateStreamReceiver();
      try{
        const response=await fetch(this.base+'/api/events?delta=1',{signal:this.controller.signal});
        if(!response.ok||!response.body)throw Error('原终端行情流暂不可用');
        const decoder=new TextDecoder();let buffer='';
        for await(const chunk of response.body){
          buffer+=decoder.decode(chunk,{stream:true});let boundary;
          while((boundary=buffer.indexOf('\n\n'))!==-1){
            const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
            if(!data)continue;
            const state=receiver.accept(JSON.parse(data));
            if(state.mode!=='paper'||state.health?.virtualOnly!==true)throw Error('来源不是模拟终端');
            const old=this.state;
            if(old&&old.csrf!==state.csrf)this.reset();
            else for(const chain of ['bsc','robinhood']){if(sourceReset(old,state,chain))this.reset(chain);else if(sourceCoverageGap(old,state,chain))this.noticeGap(chain);}
            this.state=state;this.receivedAt=Date.now();this.connected=true;this.lastError='';
          }
          if(buffer.length>8*1024*1024)throw Error('行情流消息过大');
        }
        throw Error('行情流已断开');
      }catch(e){this.connected=false;this.lastError=e.message;if(this.stopping)return;this.reset();await new Promise(r=>setTimeout(r,2000));}
    }
  }
  reset(chain=null){for(const c of chain?[chain]:['bsc','robinhood'])this.epochs[c]++;this.onGeneration(chain);}
  noticeGap(chain){this.onCoverage(chain);}
  stop(){this.stopping=true;this.connected=false;this.controller?.abort();}
}
export function sourceReset(old,state,chain='bsc'){
  return Boolean(old&&(old.csrf!==state.csrf||state.chains.some(s=>{
    if(s.chain!==chain)return false;
    const p=old.chains.find(p=>p.chain===s.chain);return p&&(s.head<p.head||p.connected&&!s.connected);
  })));
}
export function sourceCoverageGap(old,state,chain){const before=old?.chains.find(s=>s.chain===chain),after=state.chains.find(s=>s.chain===chain);return Boolean(before&&after&&after.gaps>before.gaps);}
