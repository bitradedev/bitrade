import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeEventTopics,
  decodeFunctionData,
  encodeFunctionResult,
} from 'viem';
import { CloudStore } from '../store.mjs';
import { evaluateFlapRisk } from '../../bi-trade/lib/flap-risk.mjs';
import { PaperDesk } from '../../bi-trade/lib/paper-desk.mjs';
import { TokenRiskGuard } from '../../bi-trade/lib/token-risk-core.mjs';
const require = createRequire(realpathSync('node_modules/wrangler/package.json'));
mkdirSync('.cloud-test-build', { recursive: true });
await require('esbuild').build({
  entryPoints: [
    'cloudflare/meme-data.mjs',
    'cloudflare/market.ts',
    'cloudflare/flap-data.mjs',
    'cloudflare/quote-transfers.mjs',
    'paper-terminal/src/server/adapters/math.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: '.cloud-test-build/flap-tests',
  outExtension: { '.js': '.mjs' },
});
const { flapCreations, flapTurnover, flapHolders, activeFlapLaunches, FLAP_EVENTS } =
  await import('../../.cloud-test-build/flap-tests/cloudflare/flap-data.mjs');
const { MemeBscData } = await import('../../.cloud-test-build/flap-tests/cloudflare/meme-data.mjs');
const { CloudMarket } = await import('../../.cloud-test-build/flap-tests/cloudflare/market.mjs');
const { probeQuoteTransfers, QUOTE_TRANSFER_ABI } =
  await import('../../.cloud-test-build/flap-tests/cloudflare/quote-transfers.mjs');
const { flapReserve, flapVirtualSell, v2Quote, WAD, ceilDiv } =
  await import('../../.cloud-test-build/flap-tests/paper-terminal/src/server/adapters/math.mjs');
const TOKEN = '0x' + '11'.repeat(20),
  POOL = '0x' + '22'.repeat(20),
  OWNER = '0x' + '33'.repeat(20),
  OTHER = '0x' + '44'.repeat(20),
  PORTAL = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0',
  ZERO = '0x' + '00'.repeat(20),
  WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const HASH = '0x' + 'a'.repeat(64),
  TX = '0x' + 'b'.repeat(64);
const state = () => ({
  status: 1,
  reserve: (6n * WAD) / 10n,
  circulatingSupply: 100000000n * WAD,
  price: (6600000000n * WAD * WAD * WAD) / (1000000000n * WAD) ** 2n,
  tokenVersion: 6,
  r: 6n * WAD,
  h: 100000000n * WAD,
  k: 6600000000n * WAD,
  dexSupplyThresh: 800000000n * WAD,
  quoteTokenAddress: ZERO,
  nativeToQuoteSwapEnabled: false,
  extensionID: '0x' + '00'.repeat(32),
  buyTaxRate: 100n,
  sellTaxRate: 200n,
  pool: ZERO,
  progress: 125000000000000000n,
  lpFeeProfile: 0,
  dexId: 0,
});
const creation = (at = Date.now()) => ({
  address: PORTAL,
  blockNumber: '0x64',
  blockHash: HASH,
  transactionHash: TX,
  logIndex: '0x0',
  topics: encodeEventTopics({ abi: FLAP_EVENTS, eventName: 'TokenCreated' }),
  data: encodeAbiParameters(
    parseAbiParameters('uint256,address,uint256,address,string,string,string'),
    [BigInt(Math.floor(at / 1000)), OWNER, 0n, TOKEN, 'Name', 'MEME', 'ipfs'],
  ),
});
test('Flap activity priority only uses fresh two-sided samples and never refreshes evidence timestamps',()=>{
 const now=2000000,base={sampleAt:now-1000,sample:{buys:77,sells:47}};
 const rows=[base,{...base,sampleAt:now-120000},{...base,sampleAt:now+1},{...base,sampleAt:String(now)},{...base,sample:{buys:100,sells:0}},{...base,sample:{buys:3,sells:2}}];
 const before=structuredClone(rows);assert.deepEqual(activeFlapLaunches(rows,now),[rows[0],rows[5]]);assert.deepEqual(rows,before);
});
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = {
    exec(query, ...args) {
      if (!args.length && query.split(';').filter((x) => x.trim()).length > 1) {
        db.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const s = db.prepare(query);
      if (/^(?:CREATE|DELETE|INSERT|UPDATE)/i.test(query.trim())) {
        const r = s.run(...args);
        return { toArray: () => [], rowsWritten: r.changes };
      }
      return { toArray: () => s.all(...args), rowsWritten: 0 };
    },
  };
  return new CloudStore({
    sql,
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  });
}
function gateway(t) {
  const store = fixture(t);
  let head = 100,
    s = state(),
    calls = 0;
  const rpc = {
    chain: 'bsc',
    knownBlock: () => null,
    block: async (n) => {
      calls++;
      return { number: n ?? head, time: Date.now(), hash: HASH, transactions: [] };
    },
    request: async (method) => {
      calls++;
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getLogs') return [];
      throw Error('Unexpected ' + method);
    },
    read: async (_a, _abi, name, args) => {
      calls++;
      if (name === 'getTokenV8Safe') return s;
      if (name === 'getFeeRate') return [100n, 100n];
      if (name === 'decimals') return 18;
      if (name === 'factory') return FACTORY;
      if (name === 'getPair' || name === 'mainPool') return POOL;
      if (name === 'token0') return TOKEN;
      if (name === 'token1') return WBNB;
      if (name === 'getReserves') return [1000000000n * WAD, 100n * WAD, 0];
      if (name === 'state') return 3;
      if (name === 'liquidationThreshold') return 10000000n * WAD;
      if (name === 'buyTaxRate') return s.buyTaxRate;
      if (name === 'sellTaxRate') return s.sellTaxRate;
      if (name === 'balanceOf') return _a === TOKEN ? 0n : 100n * WAD;
      if (name === 'quoteExactInput') {
        const p = args[0],
          buy = p.outputToken === TOKEN;
        if (s.status === 4) {
          const gross = buy
            ? v2Quote(p.inputAmount, 100n * WAD, 1000000000n * WAD)
            : v2Quote(
                (p.inputAmount * (10000n - s.sellTaxRate)) / 10000n,
                1000000000n * WAD,
                100n * WAD,
              );
          return buy ? (gross * (10000n - s.buyTaxRate)) / 10000n : gross;
        }
        const cs = {
          reserve: s.reserve,
          supply: s.circulatingSupply,
          r: s.r,
          h: s.h,
          k: s.k,
          threshold: s.dexSupplyThresh,
          quoteDecimals: 18,
          feeBps: 100n,
          taxBps: buy ? s.buyTaxRate : s.sellTaxRate,
        };
        if (!buy) return flapVirtualSell(cs, p.inputAmount).out;
        const net = (p.inputAmount * (10000n - 100n - s.buyTaxRate)) / 10000n;
        return (
          1000000000n * WAD + s.h - ceilDiv(s.k * WAD, s.r + s.reserve + net) - s.circulatingSupply
        );
      }
      throw Error('Unexpected ' + name);
    },
  };
  const data = new MemeBscData(store, rpc),
    market = new CloudMarket(store, {
      rpc,
      memeData: data,
      memeOnly: true,
      gmgn: {
        status: () => ({ limited: true }),
        info: () => {
          throw Error('Must not call GMGN');
        },
      },
    });
  store.put('cloud-meme-candidates', {
    id: TOKEN,
    address: TOKEN,
    symbol: 'MEME',
    name: 'Name',
    category: 'meme',
    platform: 'flap',
    active: true,
    entryRank: 0,
  });
  market.catalog.set(TOKEN, {
    id: TOKEN,
    address: TOKEN,
    chain: 'bsc',
    category: 'meme',
    symbol: 'MEME',
    entryActive: true,
  });
  market.nativePrice = {
    read: async () => ({
      id: 'native-fx',
      usd: 750,
      at: Date.now(),
      readAt: Date.now(),
      source: 'isolated oracle',
    }),
  };
  market.gas.bsc.estimate = async () => ({
    gasUsd: 0.01,
    approvalUsd: 0,
    sourceFeeFrozenAt: Date.now(),
    notes: ['isolated receipt fixture'],
  });
  return {
    store,
    rpc,
    data,
    market,
    calls: () => calls,
    setHead: (n) => (head = n),
    setState: (v) => (s = v),
  };
}
test('Flap creations verify event emitter, chain range, timestamps, identities and duplicates', () => {
  const at = Date.now(),
    l = creation(at),
    rows = flapCreations([l], 95, 105, at);
  assert.equal(rows[0].platform, 'flap');
  assert.equal(rows[0].creation.block, 100);
  assert.equal(rows[0].symbol, 'MEME');
  assert.throws(() => flapCreations([{ ...l, address: OTHER }], 95, 105, at));
  assert.throws(() => flapCreations([l], 101, 105, at));
  assert.throws(() => flapCreations([l, l], 95, 105, at));
  assert.equal(flapCreations([{ ...l, removed: true }], 95, 105, at).length, 0);
});
test('Flap turnover is actual bounded quote-token volume, never assumed native or 24h volume', () => {
  const l = {
    ...creation(),
    topics: encodeEventTopics({ abi: FLAP_EVENTS, eventName: 'TokenBought' }),
    data: encodeAbiParameters(
      parseAbiParameters('uint256,address,address,uint256,uint256,uint256,uint256'),
      [1n, TOKEN, OWNER, 100n, 5n, 1n, 10n],
    ),
  };
  const s = flapTurnover([l], TOKEN, 95, 105);
  assert.equal(s.quoteRaw, '5');
  assert.equal(s.buys, 1);
  assert.equal(s.sells, 0);
  assert.throws(() => flapTurnover([l, l], TOKEN, 95, 105));
});
test('Flap screening allows current taxed newborn curves without fabricating absent holder or bundler tags', () => {
  const s = state(),
    e = {
      token: TOKEN,
      originVerified: true,
      codeHash: HASH,
      decimals: 18,
      state: s,
      buyFeeBps: '100',
      sellFeeBps: '100',
      reserveUsd: 450,
      sellQuote: '100',
      market: { quality: 'verified', priceUsd: 0.00001 },
    };
  const r = evaluateFlapRisk(TOKEN, e);
  assert.equal(r.buyAllowed, true);
  assert.equal(r.metrics.holderCount, null);
  assert.equal(r.metrics.honeypot, null);
  assert.equal(r.metrics.bundlerObservedFloatShare, null);
  assert.equal(r.metrics.sellTaxPct, 2);
  assert.equal(evaluateFlapRisk(TOKEN, { ...e, state: { ...s, status: 2 } }).buyAllowed, false);
  assert.equal(evaluateFlapRisk(TOKEN, { ...e, sellQuote: null }).buyAllowed, false);
  assert.equal(
    evaluateFlapRisk(TOKEN, { ...e, state: { ...s, extensionID: HASH } }).buyAllowed,
    false,
  );
  assert.equal(
    evaluateFlapRisk(TOKEN, { ...e, state: { ...s, tokenVersion: 9 } }).buyAllowed,
    false,
  );
  assert.equal(
    evaluateFlapRisk(TOKEN, {
      ...e,
      holders: { available: true, largestSupplyShare: 0.3, topTenSupplyShare: 0.4, clusters: [] },
    }).buyAllowed,
    false,
  );
});
test('Flap transfer reconstruction requires full supply accounting and preserves same-transaction evidence', () => {
  const tx = (from, to, value, i) => ({
    address: TOKEN,
    blockNumber: '0x64',
    blockHash: HASH,
    transactionHash: TX,
    logIndex: '0x' + i.toString(16),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + from.slice(2).padStart(64, '0'),
      '0x' + to.slice(2).padStart(64, '0'),
    ],
    data: '0x' + value.toString(16).padStart(64, '0'),
  });
  const logs = [tx(ZERO, PORTAL, 1000n, 0), tx(PORTAL, OWNER, 100n, 1), tx(PORTAL, OTHER, 100n, 2)];
  const h = flapHolders(logs, TOKEN, 100, 100, 1000n, 200n);
  assert.equal(h.holderCount, 2);
  assert.equal(h.largestSupplyShare, 0.1);
  assert.equal(h.clusters[0].circulatingShare, 1);
  assert.throws(() => flapHolders(logs.slice(1), TOKEN, 100, 100, 1000n, 200n));
  assert.throws(() => flapHolders([...logs, logs[0]], TOKEN, 100, 100, 1000n, 200n));
});
test('Independent Flap market and risk use Portal state, real decimals and taxes with no GMGN or mature floors', async (t) => {
  const f = gateway(t),
    m = await f.market.refreshMarket(TOKEN),
    r = await f.data.riskReport(TOKEN);
  assert.equal(m.quality, 'verified');
  assert.equal(m.stage, 'curve');
  assert.equal(m.progressPct, 12.5);
  assert.equal(m.liquidityUsd, 450);
  assert.equal(m.curveVirtualReserveUsd, 4950);
  assert.equal(m.curveDepthQuality, 'curve-model-estimate');
  assert.equal(r.buyAllowed, true);
  assert.equal(r.metrics.honeypot, null);
  assert.equal(r.metrics.liquidityUsd, 450);
});
test('Flap paper entry above the former reserve-share cap uses actual impact and preserves FIFO across graduation', async (t) => {
  const f = gateway(t),
    guard = new TokenRiskGuard(f.store, {
      source: { riskReport: (token) => f.data.riskReport(token) },
    });
  t.after(() => guard.close());
  const agent = { id: 'isolated-flap', address: OWNER, mode: 'paper', paused: false };
  f.store.put('agents', agent);
  const paper = new PaperDesk(f.store, f.market, {
    buyGuard: async (_a, token, { inputRaw, nativeUsd, marketPrice, refresh }) =>
      guard.assertBuy(token, {
        sizeUsd: (Number(inputRaw) / 1e18) * nativeUsd,
        marketPrice,
        refresh,
      }),
  });
  await f.market.refreshMarket(TOKEN);
  const buy = await paper.submit(agent, {
    id: 'flap-buy',
    token: TOKEN,
    side: 'buy',
    amount: '12000000000000000',
    reason: 'isolated Flap lifecycle',
  });
  assert.equal(paper.fills(agent.id).length, 0);
  assert.ok(Number(buy.inputRaw)/1e18*buy.reference.nativeUsd > 450*0.01);
  assert.ok(buy.reference.priceImpactPct <= 2);
  buy.dueAt = 0;
  f.store.put('paper-orders', buy);
  f.setHead(101);
  await f.market.updateHead();
  await paper.tick();
  assert.equal(paper.fills(agent.id).length, 1);
  const before = paper.view(agent.id),
    lot = paper.lots(agent.id)[0];
  assert.equal(before.initialUsd, 1000);
  assert.equal(lot.orderId, 'flap-buy');
  const s = {
    ...state(),
    status: 4,
    pool: POOL,
    circulatingSupply: 800000000n * WAD,
    progress: WAD,
  };
  f.setState(s);
  f.setHead(102);
  await f.market.refreshMarket(TOKEN);
  const sell = await paper.submit(agent, {
    id: 'flap-sell',
    token: TOKEN,
    side: 'sell',
    amount: lot.remainingRaw,
  });
  sell.dueAt = 0;
  f.store.put('paper-orders', sell);
  f.setHead(103);
  await f.market.updateHead();
  await paper.tick();
  const fills = paper.fills(agent.id);
  assert.equal(fills.length, 2);
  assert.equal(fills[1].quality, 'estimated');
  assert.equal(fills[1].fees.includedInOutput, true);
  assert.equal(paper.view(agent.id).initialUsd, 1000);
  assert.equal(f.store.get('agents', agent.id).address, OWNER);
  assert.equal(f.store.get('paper-lots', lot.id).remainingRaw, '0');
  assert(Number.isFinite(paper.view(agent.id).realizedUsd));
});
test('Flap virtual reverse reflects its own exact buy on native and converted quote routes', async (t) => {
  const f = gateway(t);
  await f.market.refreshMarket(TOKEN);
  const q = await f.market.quote({
    chain: 'bsc',
    token: TOKEN,
    side: 'buy',
    nativeAmountRaw: '2000000000000000',
    recipient: OWNER,
  });
  const reverse = await f.market.quote({
    chain: 'bsc',
    token: TOKEN,
    side: 'sell',
    tokenAmountRaw: q.outputRaw,
    recipient: OWNER,
    block: q.block,
  });
  assert.equal(reverse.quality, 'estimated');
  assert(BigInt(reverse.outputRaw) > 0n);
  assert(BigInt(reverse.outputRaw) < BigInt(q.inputRaw));
});
test('Graduated Flap refuses unknown tax state, liquidation triggers and dishonest net quotes', async (t) => {
  const f = gateway(t);
  f.setState({ ...state(), status: 4, pool: POOL });
  await f.market.refreshMarket(TOKEN);
  const original = f.rpc.read;
  f.rpc.read = async (...args) => (args[2] === 'liquidationThreshold' ? 1n : original(...args));
  await assert.rejects(
    f.market.quote({
      chain: 'bsc',
      token: TOKEN,
      side: 'sell',
      tokenAmountRaw: String(WAD),
      recipient: OWNER,
    }),
    /清算/,
  );
  f.rpc.read = async (...args) => (args[2] === 'quoteExactInput' ? 123n : original(...args));
  await assert.rejects(
    f.market.quote({
      chain: 'bsc',
      token: TOKEN,
      side: 'sell',
      tokenAmountRaw: String(WAD),
      recipient: OWNER,
    }),
    /净报价/,
  );
  f.rpc.read = async (...args) => (args[2] === 'mainPool' ? OTHER : original(...args));
  await assert.rejects(
    f.market.quote({
      chain: 'bsc',
      token: TOKEN,
      side: 'sell',
      tokenAmountRaw: String(WAD),
      recipient: OWNER,
    }),
    /税状态/,
  );
});
test('Flap six-decimal conversion uses actual depegged value and supports the virtual reverse without double tax', async (t) => {
  const f = gateway(t),
    QUOTE = '0x55d398326f99059ff775485246999027b3197955',
    s = { ...state(), quoteTokenAddress: QUOTE, reserve: 600000n };
  f.setState(s);
  const original = f.rpc.read;
  f.rpc.read = async (a, abi, n, args, ...rest) => {
    if (n === 'decimals' && a === QUOTE) return 6;
    if (n === 'quoteExactInput') {
      const p = args[0],
        cs = {
          reserve: s.reserve,
          supply: s.circulatingSupply,
          r: s.r,
          h: s.h,
          k: s.k,
          threshold: s.dexSupplyThresh,
          quoteDecimals: 6,
          feeBps: 100n,
          taxBps: p.outputToken === TOKEN ? s.buyTaxRate : s.sellTaxRate,
        };
      if (p.outputToken !== TOKEN) return flapVirtualSell(cs, p.inputAmount).out;
      const net = (p.inputAmount * (10000n - 100n - s.buyTaxRate)) / 10000n;
      return (
        1000000000n * WAD +
        s.h -
        ceilDiv(s.k * WAD, s.r + (s.reserve + net) * 10n ** 12n) -
        s.circulatingSupply
      );
    }
    return original(a, abi, n, args, ...rest);
  };
  const conversion = { kind: 'v2', token: QUOTE, quote: WBNB, pool: OTHER, fee: 25 };
  f.market.venues.bsc.conversion = async (q) => (q === QUOTE ? conversion : null);
  f.data.flap.quoteMetadata = async () => ({
    id: QUOTE,
    at: Date.now(),
    source: 'flap-quote',
    info: { address: QUOTE, symbol: 'USDT', biggest_pool_address: OTHER },
    security: { address: QUOTE, buy_tax: 0, sell_tax: 0, is_honeypot: false, verifiedPool: OTHER },
  });
  const originalQuote = f.market.venues.bsc.quote.bind(f.market.venues.bsc);
  f.market.venues.bsc.quote = async (r, side, input, ...rest) =>
    r === conversion
      ? {
          out:
            side === 'buy'
              ? (input * 750n * 100n) / (99n * 10n ** 12n)
              : (input * 99n * 10n ** 12n) / (750n * 100n),
          spent: input,
          refund: 0n,
          protocol: 0n,
          tax: 0n,
          spot: (0.99 / 750) * 1e12,
          impactPct: 0,
          impactQuality: 'verified',
          notes: ['isolated exact conversion'],
        }
      : originalQuote(r, side, input, ...rest);
  const m = await f.market.refreshMarket(TOKEN);
  assert.equal(m.quality, 'verified');
  assert(Math.abs(m.quoteUsd - 0.99) < 1e-9);
  assert(Math.abs(m.liquidityUsd - 0.594) < 1e-9);
  assert(Math.abs(m.curveVirtualReserveUsd - 6.534) < 1e-9);
  const buy = await f.market.quote({
      chain: 'bsc',
      token: TOKEN,
      side: 'buy',
      nativeAmountRaw: '1000000000000',
      recipient: OWNER,
    }),
    sell = await f.market.quote({
      chain: 'bsc',
      token: TOKEN,
      side: 'sell',
      tokenAmountRaw: buy.outputRaw,
      recipient: OWNER,
      block: buy.block,
    });
  assert.equal(sell.quality, 'estimated');
  assert(BigInt(sell.outputRaw) > 0n);
  assert(BigInt(sell.outputRaw) < BigInt(buy.inputRaw));
  assert(buy.fees.taxUsd > 0);
  assert.equal(buy.fees.includedInOutput, true);
  f.market.metadata.get(QUOTE).security.proofMode = 'rpc-sequential-transfers';
  const proved = [];
  f.data.flap.quoteTransfers = async (token, pool, amount, block, recipient) => {
    assert.equal(token, QUOTE);
    assert.equal(pool, OTHER);
    assert.equal(recipient, OWNER);
    assert(amount > 0n);
    proved.push(amount);
    return { parentBlock: block, simulatedBlock: block + 1 };
  };
  const enhancedBuy = await f.market.quote({
    chain: 'bsc',
    token: TOKEN,
    side: 'buy',
    nativeAmountRaw: '1000000000000',
    recipient: OWNER,
  });
  await f.market.quote({
    chain: 'bsc',
    token: TOKEN,
    side: 'sell',
    tokenAmountRaw: enhancedBuy.outputRaw,
    recipient: OWNER,
    block: enhancedBuy.block,
  });
  assert.equal(enhancedBuy.quality, 'estimated');
  assert.match(enhancedBuy.reason, /连续转账/);
  assert.equal(proved.length, 2);
});
test('Flap declaration changes and forks do not freshen failed identity evidence or turn a healthy RPC into a recovered event index', async (t) => {
  const f = gateway(t);
  await f.data.flap.evidence(TOKEN);
  const old = f.store.get('cloud-flap-evidence', TOKEN);
  const expiredAt = old.at - 31000;
  f.store.put('cloud-flap-evidence', { ...old, at: expiredAt });
  f.rpc.request = async () => {
    throw Error('Provider unavailable');
  };
  await assert.rejects(f.data.flap.evidence(TOKEN));
  assert.equal(f.store.get('cloud-flap-evidence', TOKEN).at, expiredAt);
  f.store.put('cloud-settings', {
    id: 'flap-index',
    at: Date.now(),
    lastError: 'Flap unavailable',
    lastSuccessAt: null,
  });
  f.rpc.statusFor = () => ({
    lastError: null,
    lastSuccessAt: Date.now(),
    limited: false,
    retryAt: 0,
  });
  assert.equal(f.data.flap.status().lastError, 'Flap unavailable');
  assert.equal(f.data.flap.status().lastSuccessAt, null);
});
test('An older indexed Flap with fresh trades is sampled and retained outside the creation window without invented origins', async (t) => {
  const f=gateway(t), now=Date.now(), original=flapCreations([creation(now-1800000)],95,105,now)[0];
  f.store.put('cloud-flap-launches',{...original,sampleAt:now-1800000,sample:{buys:3,sells:1}});
  for(let i=0;i<48;i++) {const a='0x'+(2000+i).toString(16).padStart(40,'0');f.store.put('cloud-flap-launches',{...original,id:a,address:a,createdAt:now-i*1000});}
  f.store.put('paper-fills',{id:'preserved-loss',netUsd:-5});
  const trade=(token,eventName,i)=>({...creation(now),blockNumber:'0x1380',logIndex:'0x'+i.toString(16),topics:encodeEventTopics({abi:FLAP_EVENTS,eventName}),data:encodeAbiParameters(parseAbiParameters('uint256,address,address,uint256,uint256,uint256,uint256'),[BigInt(Math.floor(now/1000)),token,OWNER,100n,5n,1n,10n])});
  f.setHead(5000);let calls=0;
  f.rpc.request=async()=>++calls%2===1?[]:[trade(TOKEN,'TokenBought',1),trade(TOKEN,'TokenSold',2),trade(OTHER,'TokenBought',3),trade(OTHER,'TokenSold',4)];
  await f.data.flap.discover();
  const saved=f.store.get('cloud-flap-launches',TOKEN);
  assert.ok(saved,'An older active token must not be evicted solely by creation age');
  assert.ok(saved.sampleAt>=now);assert.equal(saved.sample.buys,1);assert.equal(saved.sample.sells,1);
  assert.equal(saved.at,original.at);assert.equal(saved.createdAt,original.createdAt);assert.deepEqual(saved.creation,original.creation);
  assert.equal(f.store.get('cloud-flap-launches',OTHER),null,'Trades alone do not establish a verified launch origin');
  assert.ok(f.store.all('cloud-flap-launches').length<=48);assert.equal(f.store.get('token-risk-reports',TOKEN),null);assert.equal(f.store.get('paper-fills','preserved-loss').netUsd,-5);
});

test('Flap indexing bounds writes in an overlapping busy creation window and preserves discovery ages', async (t) => {
  const f = gateway(t),
    rows = Array.from({ length: 40 }, (_, i) => ({
      ...creation(),
      transactionHash: '0x' + i.toString(16).padStart(64, '0'),
      logIndex: '0x' + i.toString(16),
      data: encodeAbiParameters(
        parseAbiParameters('uint256,address,uint256,address,string,string,string'),
        [
          BigInt(Math.floor(Date.now() / 1000)),
          OWNER,
          BigInt(i),
          '0x' + (1000 + i).toString(16).padStart(40, '0'),
          'Name',
          'MEME',
          'ipfs',
        ],
      ),
    }));
  f.setHead(104);
  let gets = 0;
  f.rpc.request = async () => (gets++ % 2 === 0 ? rows : []);
  const put = f.store.put.bind(f.store);
  let writes = 0;
  f.store.put = (kind, v) => {
    if (kind === 'cloud-flap-launches') writes++;
    return put(kind, v);
  };
  await f.data.flap.discover();
  assert.equal(writes, 6);
  const first = f.store.all('cloud-flap-launches')[0];
  assert.equal(f.data.flap.status().count, 40);
  assert.equal(f.data.flap.status().indexedCount, 6);
  f.store.put('cloud-settings', {
    ...f.store.get('cloud-settings', 'flap-index'),
    at: Date.now() - 61000,
  });
  writes = 0;
  await f.data.flap.discover();
  assert.equal(writes, 0);
  assert.equal(f.store.get('cloud-flap-launches', first.id).at, first.at);
});
test('Flap old creation evidence cannot pin the risk report to the curve after natural graduation', async (t) => {
  const f = gateway(t);
  await f.market.refreshMarket(TOKEN);
  f.setState({ ...state(), status: 4, pool: POOL, progress: WAD });
  f.setHead(101);
  const risk = await f.data.riskReport(TOKEN);
  assert.equal(f.market.getMarket('bsc', TOKEN).stage, 'dex');
  assert.equal(risk.buyAllowed, true);
  assert.equal(risk.metrics.progressPct, 100);
  f.setState({ ...state(), extensionID: HASH });
  f.setHead(102);
  await assert.rejects(
    f.market.quote({
      chain: 'bsc',
      token: TOKEN,
      side: 'buy',
      nativeAmountRaw: String(10n ** 15n),
      recipient: OWNER,
    }),
    /扩展/,
  );
});
function transferSimulation(payload, parent = 100, hash = HASH) {
  const amount = decodeFunctionData({
      abi: QUOTE_TRANSFER_ABI,
      data: payload.blockStateCalls[0].calls[3].data,
    }).args[1],
    p = 1000n * WAD,
    r = 17n,
    f = 23n,
    values = [
      p,
      r,
      f,
      null,
      p - amount,
      r + amount,
      null,
      r,
      f + amount,
      null,
      f,
      r + amount,
      null,
      r,
      p,
      f,
    ];
  return [
    {
      number: '0x' + (parent + 1).toString(16),
      parentHash: hash,
      timestamp: payload.blockStateCalls[0].blockOverrides.time,
      calls: values.map((v) => ({
        status: '0x1',
        gasUsed: '0x5208',
        returnData: encodeFunctionResult({
          abi: QUOTE_TRANSFER_ABI,
          functionName: v === null ? 'transfer' : 'balanceOf',
          result: v === null ? true : v < 0n ? 0n : v,
        }),
      })),
    },
  ];
}
test('Stateful quote-asset transfer proof validates exact deltas, real funding, canonical parent, next block and all four recipients without overrides', async () => {
  const time = Date.now(),
    rpc = {
      block: async () => ({ number: 100, time, hash: HASH }),
      request: async (method, [payload, block]) => {
        assert.equal(method, 'eth_simulateV1');
        assert.equal(block, '0x64');
        assert.equal(payload.validation, false);
        assert.equal(payload.blockStateCalls.length, 1);
        assert.equal(payload.blockStateCalls[0].stateOverrides, undefined);
        assert.equal(payload.blockStateCalls[0].calls.length, 16);
        assert(
          payload.blockStateCalls[0].calls.every((c) => c.to === TOKEN && !c.value && !c.signature),
        );
        return transferSimulation(payload);
      },
    };
  const p = await probeQuoteTransfers(rpc, {
    token: TOKEN,
    pool: POOL,
    recipient: OWNER,
    amountRaw: '100',
    block: 100,
  });
  assert.equal(p.quality, 'estimated');
  assert.equal(p.parentBlock, 100);
  assert.equal(p.simulatedBlock, 101);
  assert.equal(p.buyTransferTaxBps, 0);
  assert.equal(p.portalTransferTaxBps, 0);
  for (const mutate of [
    (j) => (j[0].parentHash = TX),
    (j) => (j[0].number = '0x66'),
    (j) => (j[0].calls[3].status = '0x0'),
    (j) =>
      (j[0].calls[6].returnData = encodeFunctionResult({
        abi: QUOTE_TRANSFER_ABI,
        functionName: 'transfer',
        result: false,
      })),
    (j) =>
      (j[0].calls[5].returnData = encodeFunctionResult({
        abi: QUOTE_TRANSFER_ABI,
        functionName: 'balanceOf',
        result: 116n,
      })),
    (j) => j[0].calls.pop(),
  ]) {
    await assert.rejects(
      probeQuoteTransfers(
        {
          ...rpc,
          request: async (_method, [payload]) => {
            const j = transferSimulation(payload);
            mutate(j);
            return j;
          },
        },
        { token: TOKEN, pool: POOL, recipient: OWNER, amountRaw: '100', block: 100 },
      ),
    );
  }
  await assert.rejects(
    probeQuoteTransfers(rpc, {
      token: TOKEN,
      pool: POOL,
      recipient: OWNER,
      amountRaw: String(2000n * WAD),
      block: 100,
    }),
    /到账|扣款/,
  );
});
test('Unavailable quote audit can use exact RPC transfer evidence while keeping honeypot unknown; known unsafe reports never fall through', async (t) => {
  const f = gateway(t),
    QUOTE = '0x55d398326f99059ff775485246999027b3197955';
  f.setState({ ...state(), quoteTokenAddress: QUOTE });
  await f.data.flap.evidence(TOKEN);
  await f.market.updateHead();
  f.market.venues.bsc.conversion = async () => ({
    kind: 'v2',
    token: QUOTE,
    quote: WBNB,
    pool: OTHER,
    fee: 25,
  });
  const original = f.rpc.read;
  f.rpc.read = async (...args) => (args[2] === 'symbol' ? 'TEST' : original(...args));
  let proofs = 0;
  f.rpc.request = async (method, [payload]) => {
    assert.equal(method, 'eth_simulateV1');
    proofs++;
    return transferSimulation(payload);
  };
  f.data.read = async () => {
    throw Object.assign(Error('Resource 404'), { sourceResourceMissing: true });
  };
  const md = await f.data.flap.quoteMetadata(QUOTE);
  assert.equal(md.security.proofMode, 'rpc-sequential-transfers');
  assert.equal(md.security.is_honeypot, null);
  assert.equal(md.security.buy_tax, 0);
  assert.equal(proofs, 1);
  f.data.read = async () => ({ at: Date.now(), value: { honeypotResult: { isHoneypot: true } } });
  await assert.rejects(f.data.flap.quoteMetadata(QUOTE), /已发现/);
  assert.equal(proofs, 1);
  f.data.read = async () => ({ at: Date.now(), value: { simulationResult: { buyTax: 1 } } });
  await assert.rejects(f.data.flap.quoteMetadata(QUOTE), /非零税/);
  assert.equal(proofs, 1);
});
test('Quote transfer cache remains scoped to exact amount, recipient and parent hash and never freshens the original probe time', async (t) => {
  const f = gateway(t);
  let proofs = 0,
    hash = HASH;
  f.rpc.block = async () => ({ number: 100, time: Date.now(), hash });
  f.rpc.request = async (_method, [payload]) => {
    proofs++;
    return transferSimulation(payload, 100, hash);
  };
  const a = await f.data.flap.quoteTransfers(TOKEN, POOL, 100n, 100, OWNER),
    again = await f.data.flap.quoteTransfers(TOKEN, POOL, 100n, 100, OWNER);
  assert.equal(proofs, 1);
  assert.equal(a.at, again.at);
  await f.data.flap.quoteTransfers(TOKEN, POOL, 101n, 100, OWNER);
  await f.data.flap.quoteTransfers(TOKEN, POOL, 100n, 100, OTHER);
  hash = TX;
  await f.data.flap.quoteTransfers(TOKEN, POOL, 100n, 100, OWNER);
  assert.equal(proofs, 4);
});
