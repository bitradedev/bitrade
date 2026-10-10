import {signalDeadline} from './policy.mjs';
export class SignalInbox {
 constructor(limit=128){this.limit=limit;this.items=new Map();}
 key(e){return [e.chain,e.kind,e.token,e.wallet??''].join(':');}
 offer(event,market,now){
  if(event.replayed||!event.token||event.payload?.verified!==true||event.kind==='wallet'&&!event.firstBuy)return false;
  const expires=signalDeadline(event.kind==='wallet'?'wallet':'momentum',market,event.at);if(now>=expires)return false;
  const key=this.key(event),old=this.items.get(key);if(old&&old.event.at>=event.at)return false;
  this.items.set(key,{event,expires,nextAt:now});if(this.items.size>this.limit)this.items.delete(this.items.keys().next().value);return true;
 }
 reset(chain){for(const [key,item]of this.items)if(!chain||item.event.chain===chain)this.items.delete(key);}
 due(now,limit=8){const ready=[];for(const[key,item]of this.items){if(now>=item.expires)this.items.delete(key);else if(now>=item.nextAt)ready.push(item);}
  return ready.sort((a,b)=>b.event.at-a.event.at).slice(0,limit).map(item=>{item.nextAt=now+2000;return item.event;});}
 complete(event){const key=this.key(event);if(this.items.get(key)?.event.id===event.id)this.items.delete(key);}
}
