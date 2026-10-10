import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const require = createRequire(realpathSync(fileURLToPath(new URL('../node_modules/gmgn-cli/package.json', import.meta.url))));
const { WebSocket, ProxyAgent } = require('undici');
export const PORTALS = {flap:'0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0',fourmeme:'0x5c952063c7fc8610ffdb798152d69f0b9550762b'};
const definitions = {
 flapCreated:'TokenCreated(uint256,address,uint256,address,string,string,string)',
 staged:'FlapTokenStaged(uint256,address,address)',
 flapBuy:'TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)',
 flapSell:'TokenSold(uint256,address,address,uint256,uint256,uint256,uint256)',
 fourCreated:'TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)',
 fourBuy:'TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
 fourSell:'TokenSale(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
 fourGraduated:'LiquidityAdded(address,uint256,address,uint256)',
 quote:'TokenQuoteSet(address,address)', tax:'FlapTokenTaxSet(address,uint256)',
 asymmetricTax:'FlapTokenAsymmetricTaxSet(address,uint256,uint256)', transfer:'Transfer(address,address,uint256)'
};
const methods = new Set(['eth_chainId','web3_sha3','eth_subscribe','eth_unsubscribe','eth_getLogs','eth_getTransactionReceipt','eth_getBlockByNumber']);
export function word(data,i) {
 if(!/^0x[0-9a-f]*$/i.test(data))throw Error('Invalid event hex');
 const w=data.slice(2+i*64,2+(i+1)*64);if(w.length!==64)throw Error('Short event');return w;
}
export const uint=(d,i)=>BigInt('0x'+word(d,i));
export const address=(d,i)=>'0x'+word(d,i).slice(24).toLowerCase();
export function abiString(d,i,headWords) {
 const offset=Number(uint(d,i));if(!Number.isSafeInteger(offset)||offset<headWords*32||offset%32)throw Error('Invalid string offset');
 const n=Number(uint('0x'+d.slice(2+offset*2),0));const begin=2+offset*2+64;
 if(!Number.isSafeInteger(n)||n>65536||begin+n*2>d.length)throw Error('Invalid string size');
 return Buffer.from(d.slice(begin,begin+n*2),'hex').toString('utf8').slice(0,240);
}
export function decodeEvent(log,topics) {
 const platform=Object.entries(PORTALS).find(([,a])=>a===log.address?.toLowerCase())?.[0];
 if(!platform)return null;
 const key=Object.keys(topics).find(k=>topics[k]===log.topics[0]);if(!key)return null;
 const d=log.data;
 const event={key:log.blockHash+':'+log.transactionHash+':'+log.logIndex,platform,block:parseInt(log.blockNumber,16),transactionHash:log.transactionHash,removed:!!log.removed,receivedMs:Date.now(),receivedMonotonicMs:performance.now()};
 if(key==='flapCreated')return {...event,kind:'created',token:address(d,3),creator:address(d,1),chainTimestamp:Number(uint(d,0)),name:abiString(d,4,7),symbol:abiString(d,5,7)};
 if(key==='fourCreated')return {...event,kind:'created',token:address(d,1),creator:address(d,0),launchTime:Number(uint(d,6)),name:abiString(d,3,8),symbol:abiString(d,4,8)};
 if(key==='staged')return {...event,kind:'staged',token:address(d,2),creator:address(d,1),chainTimestamp:Number(uint(d,0)),name:'尚未部署',symbol:''};
 if(key==='fourGraduated')return {...event,kind:'graduated',token:address(d,0),name:'曲线已迁移',symbol:''};
 if(/(?:flap|four)(?:Buy|Sell)$/.test(key)) {
  const flap=platform==='flap';return {...event,kind:key.endsWith('Buy')?'buy':'sell',token:address(d,flap?1:0),actor:address(d,flap?2:1),amountRaw:uint(d,3).toString(),quoteRaw:uint(d,4).toString(),chainTimestamp:flap?Number(uint(d,0)):null};
 }
 return null;
}

export class ChainFeed extends EventEmitter {
 constructor({wallets=[],proxy='http://127.0.0.1:7897',enrich=true,endpoint='wss://bsc-rpc.publicnode.com'}={}) {
  super();this.wallets=new Map(wallets.map(w=>[w.address.toLowerCase(),w.name]));this.endpoint=endpoint;this.dispatcher=proxy?new ProxyAgent(proxy):undefined;this.enrich=enrich;
  this.pending=new Map();this.subscriptions=new Map();this.topics={};this.seen=new Map();this.stopped=false;this.generation=0;this.id=0;this.retries=0;this.lastBlock=0;this.lastHeadMs=0;this.enrichmentQueue=[];this.enriching=false;this.walletTxQueue=[];this.walletTxSeen=new Map();this.walletChecking=false;
  this.status={connection:'启动中',lastBlock:0,lastHeadMs:0,reconnects:0,gaps:0,decodeErrors:0,endpoint,source:'BSC 已上链事件'};this.lastHeadMono=0;this.connectedReadyMono=0;
 }
 emitStatus(extra={}) {Object.assign(this.status,extra);this.emit('status',{...this.status});}
 async start() {await this.connect();this.health=setInterval(()=>{const reference=this.lastHeadMono||this.connectedReadyMono;if(reference&&performance.now()-reference>15000&&this.ws?.readyState===1){this.emitStatus({connection:'数据过期，正在重连'});this.ws.close();}},5000);return this;}
 rpc(method,params=[],socket=this.ws) {
  if(!methods.has(method))return Promise.reject(Error('Only public read-only RPC methods allowed'));
  if(!socket||socket.readyState!==1)return Promise.reject(Error('RPC disconnected'));
  const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RPC timeout'));},8000);this.pending.set(id,{resolve,reject,timer,socket});socket.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));});
 }
 async connect() {
  if(this.stopped)return;const gen=++this.generation;const oldBlock=this.lastBlock;
  this.lastHeadMono=0;this.connectedReadyMono=0;
  this.emitStatus({connection:this.retries?'正在重连':'正在连接'});
  const socket=new WebSocket(this.endpoint,this.dispatcher?{dispatcher:this.dispatcher}:{});this.ws=socket;this.subscriptions.clear();
  let ready=false;const closed=()=>{
   if(gen!==this.generation||this.stopped)return;
   for(const [id,p] of this.pending)if(p.socket===socket){clearTimeout(p.timer);p.reject(Error('RPC disconnected'));this.pending.delete(id);}
   this.emitStatus({connection:'连接断开',reconnects:++this.status.reconnects});
   clearTimeout(this.reconnectTimer);this.reconnectTimer=setTimeout(()=>this.connect().catch(()=>{}),Math.min(30000,1000*2**Math.min(this.retries++,5)));
  };
  socket.addEventListener('close',closed);socket.addEventListener('error',()=>socket.close());
  socket.addEventListener('message',event=>{
   if(gen!==this.generation)return;
   try {
    const msg=JSON.parse(String(event.data));
    if(msg.id){const p=this.pending.get(msg.id);if(p){clearTimeout(p.timer);this.pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}return;}
    if(msg.method!=='eth_subscription')return;
    const kind=this.subscriptions.get(msg.params.subscription),value=msg.params.result;
    if(kind==='heads') {
     const block=parseInt(value.number,16);this.lastBlock=block;this.lastHeadMs=Date.now();this.lastHeadMono=performance.now();
     this.emitStatus({connection:ready?'在线':'正在订阅',lastBlock:block,lastHeadMs:this.lastHeadMs,chainTime:Number(BigInt(value.timestamp))});
     if(oldBlock&&ready&&!this.recovered){this.recovered=true;this.recover(oldBlock,block).catch(()=>this.emitStatus({gaps:++this.status.gaps}));}
    }else if(kind==='logs')this.receive(value,false);
    else if(kind==='walletTransfers')this.receiveTransfer(value,false);
   } catch {this.emitStatus({decodeErrors:++this.status.decodeErrors});}
  });
  try {
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(Error('Connection timeout'));},10000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Connection failed'));},{once:true});});
   if(await this.rpc('eth_chainId',[],socket)!=='0x38')throw Error('Wrong chain');
   for(const [key,sig] of Object.entries(definitions))if(!this.topics[key])this.topics[key]=await this.rpc('web3_sha3',['0x'+Buffer.from(sig).toString('hex')],socket);
   this.filter={address:Object.values(PORTALS),topics:[[...Object.entries(this.topics).filter(([k])=>!['quote','tax','asymmetricTax','transfer'].includes(k)).map(([,t])=>t)]]};
   this.subscriptions.set(await this.rpc('eth_subscribe',['logs',this.filter],socket),'logs');
   this.transferFilters=[];
   if(this.wallets.size){
    const owners=[...this.wallets.keys()].map(a=>'0x'+a.slice(2).padStart(64,'0'));
    this.transferFilters=[{topics:[this.topics.transfer,owners]},{topics:[this.topics.transfer,null,owners]}];
    for(const filter of this.transferFilters)this.subscriptions.set(await this.rpc('eth_subscribe',['logs',filter],socket),'walletTransfers');
   }
   this.subscriptions.set(await this.rpc('eth_subscribe',['newHeads'],socket),'heads');
   ready=true;this.retries=0;this.recovered=false;this.connectedReadyMono=performance.now();this.emitStatus({connection:this.lastHeadMono?'在线':'等待新区块'});
  } catch(error) {socket.close();this.emitStatus({connection:'连接失败，稍后重试',lastError:String(error.message).slice(0,300)});}
 }
 async recover(from,to) {
  // Replay a short gap, labelled as historical. Never present replay as an early signal.
  if(to-from>64)this.emitStatus({gaps:++this.status.gaps});
  if(to<from)return;
  const logs=await this.rpc('eth_getLogs',[{...this.filter,fromBlock:'0x'+Math.max(from-2,to-64).toString(16),toBlock:'0x'+to.toString(16)}]);
  for(const log of logs)this.receive(log,true);
  for(const filter of this.transferFilters||[]){const transfers=await this.rpc('eth_getLogs',[{...filter,fromBlock:'0x'+Math.max(from-2,to-64).toString(16),toBlock:'0x'+to.toString(16)}]);for(const log of transfers)this.receiveTransfer(log,true);}
 }
 receive(log,replayed) {
  try {
   const e=decodeEvent(log,this.topics);if(!e)return;
   if(e.removed){this.seen.delete(e.key);for(const owner of this.wallets.keys()){const key=e.key+':wallet:'+owner;if(this.seen.delete(key))this.emit('event',{...e,key,kind:'removed',replayed});}this.emit('event',{...e,kind:'removed',replayed});return;}
   if(this.seen.has(e.key))return;
   this.seen.set(e.key,Date.now());while(this.seen.size>15000)this.seen.delete(this.seen.keys().next().value);
   if(e.kind==='buy'||e.kind==='sell'){
    // A recipient can be named by a third-party sender. Verify the receipt
    // even when a protocol event directly names a watched wallet.
    if(this.wallets.has(e.actor))this.queueWalletReceipt(log.blockHash+':'+log.transactionHash,log.transactionHash,replayed);
    return;
   }
   e.replayed=replayed;e.walletName=this.wallets.get(e.actor)||null;this.emit('event',e);
   if(e.kind==='created'&&this.enrich&&this.enrichmentQueue.length<32){this.enrichmentQueue.push(e);this.enrichNext();}
  } catch {this.emitStatus({decodeErrors:++this.status.decodeErrors});}
 }
 emitWalletTrade(event,owner,replayed,evidence) {
  const key=event.key+':wallet:'+owner;if(this.seen.has(key))return;
  this.seen.set(key,Date.now());this.emit('event',{...event,key,protocolActor:event.actor,actor:owner,walletName:this.wallets.get(owner),replayed,attribution:evidence});
 }
 receiveTransfer(log,replayed) {
  if(log.topics?.[0]!==this.topics.transfer||log.topics.length!==3)return;
  const txKey=log.blockHash+':'+log.transactionHash;
  if(log.removed){this.walletTxSeen.delete(txKey);return;}
  this.queueWalletReceipt(txKey,log.transactionHash,replayed);
 }
 queueWalletReceipt(txKey,tx,replayed) {
  if(this.walletTxSeen.has(txKey))return;
  this.walletTxSeen.set(txKey,Date.now());while(this.walletTxSeen.size>3000)this.walletTxSeen.delete(this.walletTxSeen.keys().next().value);
  if(this.walletTxQueue.length>=128){this.emitStatus({gaps:++this.status.gaps});return;}
  this.walletTxQueue.push({txKey,tx,replayed});this.checkWalletTransactions();
 }
 async checkWalletTransactions() {
  if(this.walletChecking)return;this.walletChecking=true;
  try {
   while(this.walletTxQueue.length&&!this.stopped){const job=this.walletTxQueue.shift();try{
    const receipt=await this.rpc('eth_getTransactionReceipt',[job.tx]);if(!receipt||receipt.status!=='0x1'){this.walletTxSeen.delete(job.txKey);continue;}
    this.attributeReceipt(receipt,job.replayed);
   }catch{this.walletTxSeen.delete(job.txKey);this.emitStatus({walletVerificationFailures:(this.status.walletVerificationFailures||0)+1});}}
  }finally{this.walletChecking=false;}
 }
 attributeReceipt(receipt,replayed=false) {
  const owner=receipt.from?.toLowerCase();
  // Sending a token to a followed wallet does not make the sender's buy its buy.
  // Require a transaction actually sent by that wallet and matching token flow.
  if(!this.wallets.has(owner))return;
  const transfers=receipt.logs.filter(log=>log.topics?.[0]===this.topics.transfer&&log.topics.length===3);
  const trades=receipt.logs.map(log=>decodeEvent(log,this.topics)).filter(e=>e&&['buy','sell'].includes(e.kind));
  for(const event of trades){
   const flows=transfers.filter(log=>log.address.toLowerCase()===event.token&&('0x'+log.topics[event.kind==='buy'?2:1].slice(-40)).toLowerCase()===owner);
   if(!flows.length)continue;
   this.emitWalletTrade(event,owner,replayed,'transaction sender + matching token transfer');
  }
 }
 async enrichNext() {
  if(this.enriching)return;this.enriching=true;
  try {
   while(this.enrichmentQueue.length&&!this.stopped){const e=this.enrichmentQueue.shift();try{
    const receipt=await this.rpc('eth_getTransactionReceipt',[e.transactionHash]);if(!receipt||receipt.status!=='0x1')continue;
    const buys=receipt.logs.map(log=>decodeEvent(log,this.topics)).filter(log=>log?.kind==='buy'&&log.token===e.token);
    const details={kind:'details',key:e.key,token:e.token,creationTxBuys:buys.map(b=>({buyer:b.actor,creatorBuy:b.actor===e.creator,quoteRaw:b.quoteRaw})),receiptVerified:true};
    if(e.platform==='flap'){
     let quote='0x0000000000000000000000000000000000000000',buyTax=0,sellTax=0;
     for(const log of receipt.logs.filter(l=>l.address.toLowerCase()===PORTALS.flap)){
      if(log.topics[0]===this.topics.quote&&address(log.data,0)===e.token)quote=address(log.data,1);
      if(log.topics[0]===this.topics.tax&&address(log.data,0)===e.token)buyTax=sellTax=Number(uint(log.data,1));
     }
     for(const log of receipt.logs.filter(l=>l.address.toLowerCase()===PORTALS.flap))if(log.topics[0]===this.topics.asymmetricTax&&address(log.data,0)===e.token){buyTax=Number(uint(log.data,1));sellTax=Number(uint(log.data,2));}
     Object.assign(details,{quote,buyTaxBps:buyTax,sellTaxBps:sellTax});
    }
    this.emit('event',details);
   }catch{this.emit('event',{kind:'details',key:e.key,token:e.token,receiptVerified:false});}}
  }finally{this.enriching=false;}
 }
 async stop() {
  this.stopped=true;clearInterval(this.health);clearTimeout(this.reconnectTimer);this.ws?.close();
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Stopped'));}this.pending.clear();
  if(this.dispatcher)await this.dispatcher.destroy();this.emitStatus({connection:'已停止'});
 }
}
