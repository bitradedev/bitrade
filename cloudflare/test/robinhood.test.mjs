import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {readFileSync,realpathSync,mkdirSync,writeFileSync} from 'node:fs';
import {parseAbi,encodeEventTopics,encodeAbiParameters} from 'viem';
import {PlatformRepository,digest} from '../../bi-trade/lib/database-core.mjs';
import {chainStore} from '../../bi-trade/lib/trading-network.mjs';
import {createPlatformCore} from '../../bi-trade/platform-core.mjs';
import {EncryptedVault} from '../../bi-trade/lib/vault-core.mjs';
import {PaperDesk} from '../../bi-trade/lib/paper-desk.mjs';
import {CloudRpc} from '../rpc.mjs';
const require=createRequire(realpathSync('node_modules/wrangler/package.json'));
mkdirSync('.cloud-test-build',{recursive:true});
writeFileSync('.cloud-test-build/robinhood-test-entry.ts',`export {RobinhoodData,EtherPrice,ponsLaunches,PONS_EVENTS} from '../cloudflare/robinhood-data.mjs';export {turnoverRows} from '../cloudflare/builtin-entry-evidence.mjs';export {Venues,poolId} from '../paper-terminal/src/server/adapters/venues.js';export {ReceiptGas} from '../paper-terminal/src/server/adapters/fees.js';export {CloudMarket} from '../cloudflare/market.js';`);
await require('esbuild').build({entryPoints:['.cloud-test-build/robinhood-test-entry.ts'],bundle:true,platform:'node',format:'esm',outfile:'.cloud-test-build/robinhood-test-entry.mjs'});
const {RobinhoodData,EtherPrice,ponsLaunches,PONS_EVENTS,turnoverRows,Venues,poolId,ReceiptGas,CloudMarket}=await import('../../.cloud-test-build/robinhood-test-entry.mjs');
const TOKEN='0x1111111111111111111111111111111111111111',CURVE='0x2222222222222222222222222222222222222222',WALLET='0x3333333333333333333333333333333333333333',ZERO='0x'+'0'.repeat(40),FACTORY='0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',hash='0x'+'1'.repeat(64);
function repository(t){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const base=new PlatformRepository(db,fn=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}});t.after(()=>db.close());return base;}
function gateway(){return {chain:'robinhood',block:100,headAt:Date.now(),wrongChain:false,statuses(){return [{chain:this.chain,head:this.block,headAt:this.headAt,connected:true}]},nativeReference(){return {usd:2000,at:Date.now()}},getMarket(){return {symbol:'TEST',quality:'verified',updatedAt:Date.now(),priceUsd:1}},markets(){return []},async assertExternalEntry(){},stop(){},advance(){this.block++;this.headAt=Date.now()},async quote(p){const input=p.nativeAmountRaw??p.tokenAmountRaw;return {id:'q',chain:this.wrongChain?'bsc':this.chain,token:p.token,side:p.side,block:p.block,at:Date.now(),inputRaw:input,spentInputRaw:input,refundRaw:'0',outputRaw:String(p.side==='buy'?BigInt(input)*2000n:BigInt(input)/2000n),quality:'verified',nativeUsd:2000,priceUsd:1,tokenDecimals:18,fees:{includedInOutput:true,quality:'estimated',gasUsd:.01,approvalUsd:0,protocolUsd:0,taxUsd:0,conversionUsd:0}}}};}

test('network partitions preserve every BSC amount, loss and history, including direct SQL, rollback and intent keys',t=>{
 const base=repository(t),rh=chainStore(base,'robinhood');
 for(const kind of ['paper-accounts','paper-fills','paper-orders','paper-ledger','paper-lots','token-risk-reports','cloud-markets','cloud-settings','showcase-status']){
  base.put(kind,{id:'same',agentId:'agent',nativeRaw:'123',realizedUsd:-12});rh.put(kind,{id:'same',agentId:'agent',nativeRaw:'456',chainId:4663});
  assert.equal(base.get(kind,'same').nativeRaw,'123');assert.equal(rh.get(kind,'same').nativeRaw,'456');
  rh.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind,'same');assert.equal(rh.get(kind,'same'),null);assert.equal(base.all(kind).length,1);
 }
 base.put('agents',{id:'agent',ownerId:'owner',paused:true});assert.equal(rh.get('agents','agent').paused,true);
 assert.throws(()=>rh.transaction(()=>{rh.put('paper-accounts',{id:'rollback'});throw Error('rollback')}));assert.equal(rh.get('paper-accounts','rollback'),null);
 base.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run('agent','signal','old-signature','old-order');
 rh.db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run('agent','signal','new-signature','new-order');
 assert.equal(rh.db.prepare('SELECT * FROM intents WHERE agent=? AND requestKey=?').get('agent','signal').id,'new-order');
 assert.equal(base.db.prepare('SELECT * FROM intents WHERE agent=? AND requestKey=?').get('agent','signal').id,'old-order');
});

test('Robinhood paper fills require Robinhood quotes and retain separate capital, FIFO losses and known sell quantities',async t=>{
 const base=repository(t),store=chainStore(base,'robinhood'),g=gateway(),paper=new PaperDesk(store,g),agent={id:'agent',address:WALLET,mode:'paper',paused:false};store.put('agents',agent);
 base.put('paper-accounts',{id:agent.id,initialUsd:1000,nativeRaw:'1250000000000000000',realizedNativeRaw:'-1',realizedUsd:-42,feesUsd:12});const old=JSON.stringify(base.all('paper-accounts'));
 g.wrongChain=true;await assert.rejects(paper.submit(agent,{id:'wrong',side:'buy',token:TOKEN,amount:'1000000000000000'}),/报价/);assert.equal(paper.fills().length,0);g.wrongChain=false;
 const buy=await paper.submit(agent,{id:'buy',side:'buy',token:TOKEN,amount:'1000000000000000'});buy.dueAt=0;store.put('paper-orders',buy);g.advance();await paper.tick();
 assert.equal(paper.fills()[0].chainId,4663);assert.equal(paper.view(agent.id).nativeSymbol,'ETH');assert.equal(paper.account(agent.id).initialUsd,1000);
 const amount=paper.lots(agent.id)[0].remainingRaw;await assert.rejects(paper.submit(agent,{id:'oversell',side:'sell',token:TOKEN,amount:String(BigInt(amount)+1n)}),/持仓/);
 const sell=await paper.submit(agent,{id:'sell',side:'sell',token:TOKEN,amount});sell.dueAt=0;store.put('paper-orders',sell);g.advance();await paper.tick();
 assert.equal(paper.fills().length,2);assert.ok(paper.account(agent.id).realizedUsd<0);assert.equal(paper.check(agent.id),true);assert.equal(JSON.stringify(base.all('paper-accounts')),old);assert.equal(base.all('paper-fills').length,0);
});

test('old Agent clients cannot submit BSC calldata or a buy without explicit chain 4663; auth identities remain shared',async t=>{
 const base=repository(t),store=chainStore(base,'robinhood'),vault=new EncryptedVault(Buffer.alloc(32,7)),g=gateway();
 const a={id:'agent',ownerId:'owner',...vault.create('agent'),mode:'paper',paused:false,policy:{mode:'balance'}};store.put('agents',a);
 const token='a'.repeat(43);base.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,NULL)').run(digest(token),'agent','owner',a.id,253402300799000);
 const app=await createPlatformCore({store,legacyStore:base,vault,gateway:g,showcase:false,rpc:{balance:async()=>0n}});
 const req={headers:{authorization:'Bearer '+token}};const args={token:TOKEN,amount:'1000000000000000',requestKey:'signal'};
 for(const chainId of [undefined,56,46630])await assert.rejects(app.action(req,'buy_token',{...args,...(chainId?{chainId}:{})}),/4663/);
 await assert.rejects(app.action(req,'submit_transaction',{to:WALLET,requestKey:'old'}),/未知Agent工具/);
 const result=await app.action(req,'buy_token',{...args,chainId:4663});assert.equal(result.chainId,4663);assert.equal(base.all('paper-orders').length,0);
 const account=await app.action(req,'get_account');assert.equal(account.network.chainId,4663);assert.equal(account.paperTradingPolicy.platformScreeningRequired,false);assert.equal(account.paperTradingPolicy.maxBuyPriceImpactPct,null);assert.equal(account.paperTradingPolicy.maxFillSlippageBps,3000);
 const challenge=app.auth.challenge(WALLET);assert.equal(challenge.chainId,4663);assert.match(challenge.message,/Chain ID: 4663/);
});

test('Robinhood RPC verifies chain 4663 and rejects BSC responses before a block is accepted',async()=>{
 const reply=value=>new Response(JSON.stringify({result:value}));
 const wrong=new CloudRpc('https://rpc.example.test',{chain:'robinhood',fetchImpl:async()=>reply('0x38')});await assert.rejects(wrong.block(),/主网/);
 const rpc=new CloudRpc('https://rpc.example.test',{chain:'robinhood',fetchImpl:async(_url,options)=>JSON.parse(options.body).method==='eth_chainId'?reply('0x1237'):reply({number:'0x64',hash,parentHash:hash,timestamp:'0x1',transactions:[]})});assert.equal((await rpc.block()).number,100);assert.equal(rpc.chain,'robinhood');
});

test('Pons factory and current stage are verified; Flap, arbitrary emitters and unsupported custom quote assets cannot be admitted',async t=>{
 const launch=encodeEventTopics({abi:[PONS_EVENTS[0]],eventName:'TokenLaunched',args:{token:TOKEN,curve:CURVE,deployer:WALLET}}),data=encodeAbiParameters([{type:'address'},{type:'uint256'},{type:'uint256'}],[ZERO,0n,4200000000000000000n]);
 const log={address:FACTORY,topics:launch,data,blockHash:hash,transactionHash:hash,blockNumber:'0x64',logIndex:'0x1'};
 assert.equal(ponsLaunches([log],90,100)[0].address,TOKEN);assert.throws(()=>ponsLaunches([{...log,address:WALLET}],90,100));assert.throws(()=>ponsLaunches([log,log],90,100));
 const store=chainStore(repository(t),'robinhood');let phase=1,quote=ZERO;const source=new RobinhoodData(store,{block:async()=>({number:100,hash}),read:async()=>({exists:true,token:TOKEN,curve:CURVE,phase,pairToken:quote}),request:async()=> '0x1234'});
 for(phase of [1,3])await assert.rejects(source.externalEntry(TOKEN),/阶段/);
 phase=0;quote=WALLET;await assert.rejects(source.externalEntry(TOKEN),/报价资产/);quote=ZERO;assert.equal((await source.externalEntry(TOKEN)).originVerified,true);
});

test('Pons curve and V4 volume counts exactly one quote side, rejects other curves/pools and duplicate logs',()=>{
 const topics=encodeEventTopics({abi:[PONS_EVENTS[1]],eventName:'CurveBuy',args:{buyer:WALLET,recipient:WALLET}}),data=encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'})),[100n,200n,2n,3n]);
 const log={address:CURVE,topics,data,blockHash:hash,transactionHash:hash,blockNumber:'0x64',logIndex:'0x1'},route={kind:'pons-v2',token:TOKEN,curve:CURVE,quote:ZERO};
 assert.deepEqual(turnoverRows([log],route,90,100,null),[{block:100,quoteRaw:'100',buy:true}]);assert.throws(()=>turnoverRows([log,log],route,90,100,null));assert.throws(()=>turnoverRows([{...log,address:WALLET}],route,90,100,null));
 const key={currency0:ZERO,currency1:TOKEN,fee:0,tickSpacing:200,hooks:WALLET},id=poolId(key),v4topics=encodeEventTopics({abi:[PONS_EVENTS[3]],eventName:'Swap',args:{id,sender:WALLET}}),v4data=encodeAbiParameters([{type:'int128'},{type:'int128'},{type:'uint160'},{type:'uint128'},{type:'int24'},{type:'uint24'}],[-100n,200n,1n,1n,0,0]);
 const v4={...log,address:'0x8366a39cc670b4001a1121b8f6a443a643e40951',topics:v4topics,data:v4data};assert.equal(turnoverRows([v4],{kind:'v4',token:TOKEN,quote:ZERO,key},90,100,null)[0].quoteRaw,'100');assert.throws(()=>turnoverRows([{...v4,topics:[v4topics[0],hash,...v4topics.slice(2)]}],{kind:'v4',token:TOKEN,quote:ZERO,key},90,100,null));
});

test('Pons quotes distinguish actual reserves and counterfactual reverse previews without inheriting recipient exemptions',async()=>{
 const recipients=[];const rpc={chain:'robinhood',read:async(_address,_abi,name,args,_block,recipient)=>{if(name==='currentSnipeTaxBps'){recipients.push([args[0],recipient]);return 100n;}return {getReserves:[2n*10n**18n,1000n*10n**18n],sellableTokens:500n*10n**18n,readyToGraduate:false,graduated:false,realQuoteReserve:0n,feeBps:100n,creatorTaxBps:50n}[name];}};
 const v=new Venues(rpc,{verifyPonsReserve:true}),route={kind:'pons-v2',token:TOKEN,quote:ZERO,curve:CURVE};await assert.rejects(v.quote(route,'sell',10n**18n,100,WALLET),/储备不足/);
 const q=await v.quote(route,'buy',10n**15n,100,WALLET);assert.ok(q.postBuyState.virtualRealReserve>0n);const reverse=await v.quote({...route,state:{...q.postBuyState,virtualPreview:true}},'sell',q.out,100,WALLET);assert.equal(reverse.quality,'estimated');assert.ok(reverse.out>0n);assert.deepEqual(recipients,[[WALLET,WALLET]]);
});

test('ETH dollar references verify the currency, never use BNB, and preserve the actual observed time',async()=>{
 const price=new EtherPrice(async()=>Response.json({data:{base:'BNB',currency:'USD',amount:'500'}}),()=>100);await assert.rejects(price.read(),/身份/);price.fetch=async()=>Response.json({data:{base:'ETH',currency:'USD',amount:'2400'}});assert.deepEqual(await price.read(),{id:'native-fx',usd:2400,at:100,readAt:100,source:'Coinbase ETH/USD spot · observed reference'});
});

test('WETH paper routes charge native-account wrapping, quote approval and exit unwrapping without changing native ETH fees',async()=>{
 const gas=new ReceiptGas({chain:'robinhood'}),frozen={gasUsedRaw:'100000',gasPriceRaw:'1000000000',sampleBlock:99,sampleTransaction:hash,sourceFeeFrozenAt:1000};
 const native={kind:'pons-v2',token:TOKEN,quote:ZERO,curve:CURVE},wrapped={...native,quote:'0x0bd7d308f8e1639fab988df18a8011f41eacad73'};
 const buy=await gas.estimate(native,100,'buy',2000,1,frozen),sell=await gas.estimate(native,100,'sell',2000,1,frozen);
 assert.equal(buy.gasUsd,.2);assert.equal(buy.approvalUsd,0);assert.equal(sell.gasUsd,.2);assert.equal(sell.approvalUsd,.05);
 for(const side of ['buy','sell']){
  const fee=await gas.estimate(wrapped,100,side,2000,1,frozen);
  assert.equal(fee.gasUsd,.4);assert.equal(fee.approvalUsd,.05);assert.equal(fee.sourceFeeFrozenAt,1000);assert.match(fee.notes.join(' '),/WETH/);assert.match(fee.notes.join(' '),/未实测执行/);
 }
 const v4=await gas.estimate({...wrapped,kind:'v4'},100,'buy',2000,1,frozen);assert.equal(v4.gasUsd,.4);assert.equal(v4.approvalUsd,.05);
 await assert.rejects(gas.estimate(wrapped,98,'buy',2000,1,frozen),/未来/);
 const legacy=await new ReceiptGas({chain:'bsc'}).estimate(native,100,'sell',2000,2,frozen);assert.equal(legacy.gasUsd,.4);assert.equal(legacy.approvalUsd,.1);
});

test('Robinhood routes cannot fall back to Pons V1, Flap or a foreign catalog after launch identity changes',async t=>{
 const store=chainStore(repository(t),'robinhood');store.put('cloud-markets',{id:TOKEN,address:TOKEN,chain:'bsc',quality:'verified'});
 const g=new CloudMarket(store,{chain:'robinhood',rpc:{chain:'robinhood'},gmgn:{},memeOnly:true});assert.equal(g.markets().length,0);
 g.loadMetadata=async()=>({info:{}});for(const route of [{kind:'v3',token:TOKEN,quote:ZERO},{kind:'flap',token:TOKEN,quote:ZERO},{kind:'v4',token:TOKEN,quote:ZERO,state:{platform:'other'}}]){g.venues.robinhood.resolve=async()=>route;await assert.rejects(g.route('robinhood',TOKEN,100),/Pons V2/);}
 await assert.rejects(g.route('bsc',TOKEN,100),/网络/);
});
