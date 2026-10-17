import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync, mkdirSync } from 'node:fs';
import { marketRuntime } from '../market-runtime.mjs';
import { IOBudget } from '../io-budget.mjs';
const require = createRequire(realpathSync('node_modules/wrangler/package.json'));
mkdirSync('.cloud-test-build', { recursive: true });
await require('esbuild').build({
  entryPoints: ['cloudflare/market.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.cloud-test-build/refresh-market.mjs',
});
const { CloudMarket } = await import('../../.cloud-test-build/refresh-market.mjs');
const token = (i) => '0x' + i.toString(16).padStart(40, '0');
function fixture(options = {}) {
  const rows = new Map();
  const store = {
    all: (k) =>
      [...rows].filter(([key]) => key.startsWith(k + ':')).map(([, v]) => structuredClone(v)),
    get: (k, id) => rows.get(k + ':' + id) || null,
    put: (k, r) => rows.set(k + ':' + r.id, structuredClone(r)),
  };
  const market = new CloudMarket(store, { memeOnly: true, gmgn: {}, ...options });
  market.updateHead = async () => ({ number: 100, time: Date.now() });
  market.fx = async () => ({ usd: 750 });
  return { market, store };
}
test('Exact requested refresh never spends its evidence window or request budget on unrelated discovery', async () => {
  const { market } = fixture();
  let discovered = 0;
  const refreshed = [];
  market.catalog.set(token(1), { address: token(1), category: 'meme' });
  market.discover = async () => {
    discovered++;
  };
  market.refreshMarket = async (t) => refreshed.push(t);
  await market.refresh([token(1)], { onlyRequested: true, limit: 1 });
  assert.equal(discovered, 0);
  assert.deepEqual(refreshed, [token(1)]);
});

test('A contract lookup arriving during background refresh still refreshes its exact token', async () => {
  const {market}=fixture();
  let release,entered;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const visited=[];
  market.catalog.set(token(1),{address:token(1),category:'meme'});
  market.discover=async()=>{};
  market.refreshMarket=async value=>{visited.push(value);if(value===token(1)){entered();await waiting;}};
  const background=market.refresh([],{limit:1});
  await started;
  const lookup=market.refresh([token(2)],{onlyRequested:true,limit:1});
  const duplicate=market.refresh([token(2)],{onlyRequested:true,limit:1});
  assert.equal(lookup,duplicate,'Identical contract lookups share one queued refresh');
  const other=market.refresh([token(3)],{onlyRequested:true,limit:1});
  release();
  await Promise.all([background,lookup,duplicate,other]);
  assert.deepEqual(visited,[token(1),token(2),token(3)]);
  assert.equal(market.requestedRefreshes.size,0);
});
test('Self-hosted refresh prioritizes actual activity, covers all exploration slots and covers twelve candidates in three rounds with four jobs running', async () => {
  const now = Date.now(),
    candidates = Array.from({ length: 12 }, (_, i) => ({
      id: token(i + 1),
      address: token(i + 1),
      category: 'meme',
      entryRank: i,
    }));
  Object.assign(candidates[8], { sampleAt: now, sample: { buys: 273, sells: 119 } });
  const runtime = marketRuntime({ BI_TRADE_SELF_HOSTED: 'true' }),
    { market, store } = fixture({ runtime, memeData: { candidates: () => candidates } });
  for (const m of candidates)
    market.catalog.set(m.address, { ...m, updatedAt: now - 16000, quality: 'verified' });
  market.discover = async () => {};
  const visited = new Set(),
    batches = [];
  let running = 0,
    peak = 0;
  market.refreshMarket = async (t) => {
    running++;
    peak = Math.max(peak, running);
    visited.add(t);
    await Promise.resolve();
    market.catalog.set(t, { ...market.catalog.get(t), updatedAt: Date.now() });
    running--;
  };
  for (let i = 0; i < 3; i++) {
    await market.refresh([], { limit: runtime.refreshBatch });
    const b = store.get('cloud-settings', 'market-cursor').lastBatch;
    batches.push(b);
    assert.equal(b.length, 6);
    assert.ok(b.some((m) => m.token === candidates[8].address));
  }
  assert.equal(visited.size, 12, 'An independent exploration cursor must not skip odd slots');
  assert.equal(peak, 4);
  assert.equal(market.prioritizedEntryMarkets()[0].address, candidates[8].address);
  const saved = store.get('cloud-settings', 'market-cursor');
  const rebuilt = new CloudMarket(store, { memeOnly: true, gmgn: {}, runtime });
  assert.equal(rebuilt.explorationCursor, saved.explorationNext);
  assert.equal(
    store.get('token-risk-reports', candidates[8].address),
    null,
    'Activity is never buying permission',
  );
});
test('Held tokens and a busy launch cannot starve other entries or consume their first refresh batch', async () => {
  const now = Date.now(), held = [token(101), token(102)],
    candidates = Array.from({ length: 6 }, (_, i) => ({
      address: token(i + 1), id: token(i + 1), category: 'meme', entryRank: i,
    }));
  Object.assign(candidates[0], {sampleAt: now, sample: {buys: 50, sells: 10}});
  const {market, store} = fixture({runtime: marketRuntime({BI_TRADE_SELF_HOSTED:'true'}), memeData:{candidates:()=>candidates}});
  const old = now - 20000;
  for(const m of [...candidates, ...held.map(address=>({address,category:'meme',entryActive:false}))])
    market.catalog.set(m.address,{...m,updatedAt:old,quality:'verified'});
  market.discover=async()=>{};
  const visited=new Set();let batch=[];
  market.refreshMarket=async t=>{batch.push(t);visited.add(t);market.catalog.set(t,{...market.catalog.get(t),updatedAt:Date.now()});};
  for(let i=0;i<5;i++){
    batch=[];await market.refresh(held,{limit:2});
    assert.equal(batch[0],candidates[0].address);
    assert.equal(batch.length,4);
    assert.ok(!held.includes(batch[1])&&batch[1]!==candidates[0].address,'Exploration reaches the first parallel batch');
    assert.ok(held.every(t=>batch.includes(t)),'Held price refreshes remain present');
  }
  assert.equal(visited.size,8,'Every other entry gets an actual refresh while positions remain held');
  assert.equal(store.get('cloud-settings','market-cursor').explorationNext,0);
  assert.equal(store.get('token-risk-reports',candidates[1].address),null,'A fresh price cannot create buying permission');
  const one = fixture({runtime:marketRuntime({BI_TRADE_SELF_HOSTED:'true'}),memeData:{candidates:()=>[]}}).market;
  one.discover=async()=>{};for(const m of candidates)one.catalog.set(m.address,{...m,updatedAt:old,quality:'verified'});
  const first=[];one.refreshMarket=async t=>{first.push(t);};await one.refresh([], {limit:2});
  assert.equal(first.length,2,'Without competing priorities the configured batch size is unchanged');
});

test('Six-token price pulses use four bounded jobs, rotate peers and never freshen a failed price or risk report', async () => {
  const {market,store}=fixture({runtime:marketRuntime({BI_TRADE_SELF_HOSTED:'true'})}),now=Date.now(),old=now-20000;
  const candidates=Array.from({length:8},(_,i)=>token(i+1));
  market.fxValue={usd:750,at:now};
  for(const address of candidates){
    market.catalog.set(address,{address,category:'meme',quality:'verified',updatedAt:old});
    market.metadata.set(address,{source:'flap-bsc',at:now});
    store.put('token-risk-reports',{id:address,policy:'bsc-flap-paper-v1',buyAllowed:true,fetchedAt:old});
  }
  const visited=new Set();let running=0,peak=0;
  market.refreshMarket=async address=>{
    running++;peak=Math.max(peak,running);visited.add(address);
    try{await new Promise(resolve=>setImmediate(resolve));if(address===candidates[0])throw Error('Read failed');market.catalog.set(address,{...market.catalog.get(address),updatedAt:Date.now()});}
    finally{running--;}
  };
  await market.pulse(6);assert.equal(visited.size,6);assert.equal(peak,4);
  await market.pulse(6);assert.equal(visited.size,8);assert.equal(market.catalog.get(candidates[0]).updatedAt,old);
  assert.ok(candidates.slice(1).every(t=>market.catalog.get(t).updatedAt>old));
  assert.ok(candidates.every(t=>store.get('token-risk-reports',t).fetchedAt===old));
});

test('Self-hosted request capacity is bounded separately while the Cloudflare limit stays 45', async () => {
  const cloud = marketRuntime(),
    server = marketRuntime({ BI_TRADE_SELF_HOSTED: 'true' });
  assert.equal(cloud.requestsPerRound, 45);
  assert.equal(cloud.rpcConcurrency, 1);
  assert.equal(cloud.flapIntervalMs, 120000);
  assert.equal(server.rpcConcurrency, 4);
  assert.equal(server.flapIntervalMs, 30000);
  const io = new IOBudget(server.requestsPerRound, async () => Response.json({}));
  await io.run('alarm', async () => {
    for (let i = 0; i < 128; i++) await io.fetch('https://isolated.example');
    assert.throws(() => io.fetch('https://over-budget.example'), { code: 'CF_SUBREQUEST_BUDGET' });
  });
  assert.equal(io.lastAlarm.used, 128);
  assert.equal(io.lastAlarm.exhausted, true);
});
