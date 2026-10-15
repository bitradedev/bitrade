import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicBscData } from '../public-data.mjs';
import { retryAfter } from '../retry-after.mjs';
import { ESTABLISHED_ASSETS, evaluateEstablishedRisk } from '../../bi-trade/lib/established-risk.mjs';
import { TokenRiskGuard } from '../../bi-trade/lib/token-risk-core.mjs';
const A = ESTABLISHED_ASSETS[0], WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', NOW = 1791665000000;
const store = () => { const rows = new Map(); return { get:(kind,id) => rows.get(kind+':'+id) ?? null, put:(kind,v) => {rows.set(kind+':'+v.id,structuredClone(v));return v; } }; };
function evidence() {
  return {pair:{chainId:'bsc',dexId:'pancakeswap',pairAddress:A.pool,baseToken:{address:A.address,symbol:'CAKE'},quoteToken:{address:WBNB},labels:['v2'],priceUsd:'2',liquidity:{usd:1000000},volume:{h24:100000}},check:{chain:{id:'56'},token:{address:A.address,totalHolders:1000000},pair:{chainId:'56',pair:{address:A.pool},createdAtTimestamp:'1619167423'},simulationSuccess:true,simulationResult:{buyTax:0,sellTax:0,transferTax:0},honeypotResult:{isHoneypot:false},contractCode:{openSource:true,rootOpenSource:true,isProxy:false,hasProxyCalls:false},summary:{riskLevel:1,flags:[]}},holders:{totalSupply:'1000000',holders:Array.from({length:50},(_,i)=>({address:'0x'+String(i+100).padStart(40,'0'),balance:'10000',isContract:false}))},proof:{codeHash:A.codeHash,pool:A.pool,totalSupply:'1000000',burnBalance:'0',poolBalance:'10000'}};
}
test('Mature paper screening is exact-address scoped and keeps absent bundler data explicitly unknown',()=>{
 const r=evaluateEstablishedRisk(A.address,evidence(),NOW);
 assert.equal(r.state,'screened-limited');assert.equal(r.buyAllowed,true);assert.equal(r.policy,'established-spot-v1');assert.equal(r.metrics.bundlerVolumeShare,null);assert.equal(r.metrics.bundlerObservedFloatShare,null);assert.match(r.warnings.join(' '),/未取得/);
 const unknown='0x'+'ab'.repeat(20),d=evidence();d.pair.baseToken.address=unknown;d.check.token.address=unknown;
 assert.equal(evaluateEstablishedRisk(unknown,d,NOW).buyAllowed,false);
});
test('Wrong chain, pool, code, proxy, missing taxes and failed sell detection cannot pass mature screening',()=>{
 const mutations=[d=>d.pair.chainId='ethereum',d=>d.pair.pairAddress=WBNB,d=>d.check.chain.id='1',d=>d.check.pair.chainId='1',d=>d.proof.codeHash='0x'+'aa'.repeat(32),d=>d.check.contractCode.isProxy=true,d=>delete d.check.simulationResult.sellTax,d=>d.check.simulationResult.transferTax='',d=>d.check.simulationResult.buyTax=false,d=>d.check.simulationSuccess=false,d=>d.check.honeypotResult.isHoneypot=true,d=>d.check.summary.riskLevel=30,d=>d.check.summary.flags=[{severityIndex:16}]];
 for(const mutate of mutations){const d=evidence();mutate(d);assert.equal(evaluateEstablishedRisk(A.address,d,NOW).buyAllowed,false);}
});
test('Mature paper policy rejects thin, young, inactive and concentrated pools without excluding arbitrary contract holders',()=>{
 for(const mutate of [d=>d.pair.liquidity.usd=499999,d=>d.pair.volume.h24=9999,d=>d.check.token.totalHolders=99999,d=>d.check.pair.createdAtTimestamp=String(NOW/1000-86400),d=>d.holders.holders=[],d=>d.holders.totalSupply='100',d=>{d.holders.holders[0].balance='400000';d.holders.holders[0].isContract=true;}]){const d=evidence();mutate(d);assert.equal(evaluateEstablishedRisk(A.address,d,NOW).buyAllowed,false);}
});
test('Independent source uses only public read-only hosts, coalesces reads, persists age and honors rate limits across reconstruction',async()=>{
 const s=store();let now=NOW,calls=0;
 const fetchImpl=async(url,opts)=>{calls++;assert.match(url,/^https:\/\/api\.dexscreener\.com\//);assert.equal(opts.method,'GET');assert.equal(opts.redirect,'manual');assert.deepEqual(opts.headers,{Accept:'application/json'});return Response.json({pairs:[]});};
 let p=new PublicBscData(s,{}, {fetchImpl,now:()=>now});
 const [a,b]=await Promise.all([p.read('dex','/test'),p.read('dex','/test')]);assert.equal(calls,1);assert.equal(a.at,b.at);
 now+=1000;p=new PublicBscData(s,{}, {fetchImpl,now:()=>now});assert.equal((await p.read('dex','/test')).at,NOW);assert.equal(calls,1);
 now+=60000;p=new PublicBscData(s,{}, {fetchImpl:async()=>{calls++;return Response.json({}, {status:429,headers:{'Retry-After':'600'}});},now:()=>now});
 await assert.rejects(p.read('dex','/test'),/429/);const retry=p.status()[0].retryAt;assert.ok(retry>=now+605000);
 const q=new PublicBscData(s,{}, {fetchImpl,now:()=>now});await assert.rejects(q.read('dex','/test'),/冷却/);assert.equal(calls,2);
 now=retry;assert.equal((await q.read('dex','/test')).at,now);assert.equal(calls,3);
});
test('Source rejects old cached responses, redirects and unexpected business errors',async()=>{
 for(const response of [Response.json({}, {headers:{Age:'121'}}),new Response(null,{status:302,headers:{Location:'https://other.example'}}),Response.json({error:'temporarily unavailable'}),Response.json({code:4029})]){
  const p=new PublicBscData(store(),{}, {fetchImpl:async()=>response,now:()=>NOW});await assert.rejects(p.read('safety','/test'));assert.equal(p.status()[1].limited,true);
 }
});
test('Retry-After seconds cannot become a future calendar year and recovery retains the original failure',async()=>{
 const s=store();let now=NOW,calls=0;
 let p=new PublicBscData(s,{}, {fetchImpl:async()=>{calls++;return Response.json({}, {status:429,headers:{'Retry-After':'39'}});},now:()=>now});
 await assert.rejects(p.read('dex','/test'),/429/);
 const budget=p.status()[0];assert.equal(budget.retryAt,NOW+300000);
 p=new PublicBscData(s,{}, {fetchImpl:async()=>{calls++;return Response.json({pairs:[]});},now:()=>now});
 now=NOW+299999;await assert.rejects(p.read('dex','/test'),/冷却/);assert.equal(calls,1);
 now=NOW+300000;assert.equal((await p.read('dex','/test')).at,now);assert.equal(calls,2);assert.equal(p.status()[0].limited,false);
 assert.deepEqual(p.status()[0].lastFailure,{at:NOW,status:429,serverRetryAt:NOW+39000});
});
test('Retry-After parser separates numeric delays, HTTP dates and malformed values without clipping valid long waits',()=>{
 for(const seconds of ['0','1','39','49','600','2039','100000',' 39 '])assert.deepEqual(retryAfter(seconds,NOW),{kind:'seconds',at:NOW+Number(seconds)*1000});
 const future=Date.UTC(2039,0,1);assert.deepEqual(retryAfter(new Date(future).toUTCString(),NOW),{kind:'date',at:future});
 for(const date of ['Sunday, 06-Nov-94 08:49:37 GMT','Sun Nov  6 08:49:37 1994'])assert.deepEqual(retryAfter(date,NOW),{kind:'date',at:Date.UTC(1994,10,6,8,49,37)});
 for(const invalid of ['', '39.5','-1','Infinity','1e9','01/01/2039','2039-01-01','9'.repeat(40)])assert.deepEqual(retryAfter(invalid,NOW),{kind:'invalid',at:null});
 assert.deepEqual(retryAfter(null,NOW),{kind:'missing',at:null});
});
test('Slow error responses start Retry-After waiting when the response arrives, not when the request began',async()=>{
 for(const [header,wait]of [['600',605000],[null,300000]]){
  let now=NOW;const p=new PublicBscData(store(),{}, {fetchImpl:async()=>{now+=12000;return Response.json({}, {status:429,headers:header?{'Retry-After':header}:{}});},now:()=>now});
  await assert.rejects(p.read('dex','/test'),/429/);assert.equal(p.status()[0].lastAt,NOW);assert.equal(p.status()[0].retryAt,NOW+12000+wait);assert.equal(p.status()[0].lastFailure.at,NOW+12000);
 }
});
test('Valid explicit HTTP dates are honored even if they match the known old parser failure',async()=>{
 const s=store(),now=1791669862535,deadline=2177452805000;
 let p=new PublicBscData(s,{}, {fetchImpl:async()=>Response.json({}, {status:429,headers:{'Retry-After':new Date(deadline-5000).toUTCString()}}),now:()=>now});
 await assert.rejects(p.read('dex','/test'),/429/);assert.equal(p.status()[0].retryAt,deadline);assert.equal(p.status()[0].retryAfterKind,'date');
 p=new PublicBscData(s,{}, {fetchImpl:async()=>{throw Error('Must honor explicit future deadline');},now:()=>now+600000});
 await assert.rejects(p.read('dex','/test'),/冷却/);assert.equal(p.status()[0].retryAt,deadline);assert.equal(s.get('cloud-settings','public-retry-correction-20261011'),null);
});
test('Only the known untyped legacy cooldown is corrected once, preserves its record and waits conservatively before recovery',async()=>{
 const s=store(),old={id:'public-budget-dex',lastAt:1791669862535,retryAt:2177452805000,lastError:'HTTP 429',lastSuccessAt:1791669830099};
 s.put('cloud-settings',old);s.put('token-risk-reports',{id:'keep-risk',value:'unknown'});s.put('paper-ledger',{id:'keep-loss',value:-87});
 let now=old.lastAt+300000,calls=0;const fetchImpl=async()=>{calls++;return Response.json({pairs:[]});};
 let p=new PublicBscData(s,{}, {fetchImpl,now:()=>now});
 const corrected=old.lastAt+2039*1000+5000;assert.equal(p.status()[0].retryAt,corrected);
 const audit=s.get('cloud-settings','public-retry-correction-20261011');assert.deepEqual(audit.previous,old);assert.equal(audit.headerKnown,false);assert.equal(audit.delayUpperBoundSeconds,2039);
 now=corrected-1;p=new PublicBscData(s,{}, {fetchImpl,now:()=>now});assert.equal(p.status()[0].retryAt,corrected);assert.deepEqual(s.get('cloud-settings',audit.id),audit);
 await assert.rejects(p.read('dex','/test'),/冷却/);assert.equal(calls,0);
 now=corrected;assert.equal((await p.read('dex','/test')).at,now);assert.equal(calls,1);assert.equal(p.status()[0].retryAt,0);
 assert.equal(p.status()[0].cooldownCorrectionId,audit.id);assert.deepEqual(s.get('cloud-settings',audit.id),audit);assert.equal(s.get('token-risk-reports','keep-risk').value,'unknown');assert.equal(s.get('paper-ledger','keep-loss').value,-87);
 for(const change of [o=>o.lastAt++,o=>o.retryAt++,o=>o.lastError='HTTP 503',o=>o.id='public-budget-safety',o=>o.retryAfterVersion=2]){const other=store(),row={...old};change(row);other.put('cloud-settings',row);new PublicBscData(other,{}, {now:()=>now});assert.deepEqual(other.get('cloud-settings',row.id),row);assert.equal(other.get('cloud-settings',audit.id),null);}
 const late=store();late.put('cloud-settings',old);new PublicBscData(late,{}, {now:()=>corrected+1000});assert.equal(late.get('cloud-settings',old.id).retryAt,corrected+301000);
});
test('HTTP cache age is subtracted from evidence time instead of refreshing old upstream data',async()=>{
 const p=new PublicBscData(store(),{}, {fetchImpl:async()=>Response.json({pairs:[]},{headers:{Age:'30'}}),now:()=>NOW});
 assert.equal((await p.read('dex','/test')).at,NOW-30000);
});
test('Holder source failures do not invalidate independent exit trading evidence but cannot allow an entry',async()=>{
 const s=store(),p=new PublicBscData(s,{}, {now:()=>NOW}),d=evidence();
 p.evidence=p.tradingEvidence=async()=>({...d,at:NOW});p.read=async()=>{throw Error('holders down');};
 const md=await p.metadata(A.address);assert.equal(md.source,'public-bsc');assert.equal(md.security.verifiedPool,A.pool);await assert.rejects(p.riskReport(A.address),/holders down/);
});
test('Chart cooldown cannot block proven mature trading metadata or fabricate missing chart statistics',async()=>{
 const s=store(),p=new PublicBscData(s,{}, {now:()=>NOW}),d=evidence();
 s.put('cloud-settings',{id:'public-budget-dex',retryAt:NOW+300000,lastError:'HTTP 429'});
 p.tradingEvidence=async()=>({...d,at:NOW});p.evidence=async()=>{throw Error('chart cooldown');};
 const md=await p.metadata(A.address);assert.equal(md.at,NOW);assert.equal(md.marketDataAt,null);assert.equal(md.info.symbol,A.symbol);assert.equal(md.info.liquidity,null);assert.equal(md.info.price.volume_24h,null);assert.equal(md.info.priceChange,null);assert.equal(md.info.txns,null);assert.equal(md.security.verifiedPool,A.pool);
 await assert.rejects(p.riskReport(A.address),/chart cooldown/);assert.equal(p.status()[0].retryAt,NOW+300000);
});
test('Trading proofs coalesce without chart requests, preserve upstream age and reject unsupported tokens',async()=>{
 const s=store();let now=NOW,reads=0,calls=0;
 const rpc={block:async()=>({number:100}),request:async()=>{reads++;return '0x6000';},read:async(_to,_abi,name,args)=>{reads++;return name==='getPair'?A.pool:name==='totalSupply'?1000000n:args[0]===A.pool?10000n:0n;}};
 const fetchImpl=async url=>{calls++;assert.match(url,/^https:\/\/api\.honeypot\.is\//);return Response.json(evidence().check,{headers:{Age:'30'}});};
 let p=new PublicBscData(s,rpc,{fetchImpl,now:()=>now});
 const [a,b]=await Promise.all([p.tradingEvidence(A.address),p.tradingEvidence(A.address)]);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(reads,5);assert.equal(a.at,NOW-30000);assert.equal(a.proof.block,100);
 p=new PublicBscData(s,rpc,{fetchImpl,now:()=>now});assert.equal((await p.tradingEvidence(A.address)).at,NOW-30000);assert.equal(calls,1);assert.equal(reads,5);
 await assert.rejects(p.metadata(A.address),/身份/);await assert.rejects(p.tradingEvidence(WBNB),/名单外/);
 now+=60000;await p.tradingEvidence(A.address);assert.equal(calls,2);assert.equal(reads,10);
});
test('Optional chart statistics retain their original timestamp and disappear when stale or from a different pool',async()=>{
 const s=store();let now=NOW;const p=new PublicBscData(s,{}, {now:()=>now}),d=evidence();
 d.pair.priceChange={h24:2};d.pair.txns={h24:{buys:10,sells:9}};
 p.tradingEvidence=async()=>({...d,at:now});
 const id='dex:/latest/dex/pairs/bsc/'+A.pool;s.put('cloud-public-cache',{id,at:NOW-30000,value:{pairs:[d.pair]}});
 let md=await p.metadata(A.address);assert.equal(md.at,NOW);assert.equal(md.marketDataAt,NOW-30000);assert.deepEqual(md.info.priceChange,{h24:2});
 now=NOW+90000;md=await p.metadata(A.address);assert.equal(md.marketDataAt,null);assert.equal(md.info.liquidity,null);assert.equal(md.info.priceChange,null);assert.equal(md.info.txns,null);
 s.put('cloud-public-cache',{id,at:now,value:{pairs:[{...d.pair,quoteToken:{address:A.address}}]}});assert.equal((await p.metadata(A.address)).marketDataAt,null);
 for(const value of [{pairs:{}},{pairs:[null,{pairAddress:123}]},{pairs:[{...d.pair,baseToken:{address:{}}}]},{pairs:[{...d.pair,labels:{}}]}]){s.put('cloud-public-cache',{id,at:now,value});assert.equal((await p.metadata(A.address)).marketDataAt,null);}
});
test('Risk guard consumes the independent mature report with original age and still sends arbitrary tokens to strict GMGN screening',async()=>{
 const s=store();let oldCalls=0;const report=evaluateEstablishedRisk(A.address,evidence(),NOW);
 const guard=new TokenRiskGuard(s,{now:()=>NOW,source:{riskReport:async t=>t===A.address?report:null,info:async()=>{oldCalls++;throw Error('GMGN banned');}}});
 assert.equal((await guard.refresh(A.address)).buyAllowed,true);assert.equal(oldCalls,0);
 await guard.assertBuy(A.address,{sizeUsd:100,marketPrice:2});await guard.assertBuy(A.address,{sizeUsd:20000,marketPrice:2});
 assert.equal((await guard.refresh('0x'+'ab'.repeat(20))).buyAllowed,false);assert.equal(oldCalls,1);
 report.fetchedAt=NOW-120001;s.put('token-risk-reports',report);assert.equal(guard.snapshot(A.address).buyAllowed,false);
});
test('Independent metadata cannot substitute another trading pair or incomplete identity proof',async()=>{
 for(const change of [d=>d.check.token.address=WBNB,d=>d.check.chain.id='1',d=>d.check.pair.chainId='1',d=>d.check.pair.pair.address=WBNB,d=>d.check.simulationSuccess=false,d=>d.check.contractCode.isProxy=true,d=>d.check.honeypotResult.isHoneypot=true,d=>d.proof.pool=WBNB,d=>d.proof.codeHash=WBNB,d=>delete d.check.simulationResult.buyTax,d=>delete d.check.simulationResult.sellTax,d=>d.check.simulationResult.transferTax=1,d=>d.at=NOW-120000,d=>d.at=NOW+1000]){
  const p=new PublicBscData(store(),{}, {now:()=>NOW}),d={...evidence(),at:NOW};change(d);p.tradingEvidence=async()=>d;await assert.rejects(p.metadata(A.address),/身份/);
 }
});
