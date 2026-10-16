import { parseAbi, decodeEventLog, getEventSelector } from 'viem';
import { PONS_EVENTS } from './robinhood-data.mjs';
import { CHAIN_CONFIG } from '../paper-terminal/src/server/adapters/types.js';
import { poolId } from '../paper-terminal/src/server/adapters/venues.js';
import { FLAP_EVENTS } from './flap-data.mjs';
import { FLAP } from '../paper-terminal/src/server/adapters/types.js';
import { assertVolume5m, volumeEligibility } from '../bi-trade/lib/builtin-entry-policy.mjs';
import { retryAfter } from './retry-after.mjs';

export const SWAPS = parseAbi([
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)',
]);
const META = parseAbi(['function metaURI() view returns (string)']);
const lower = (x) => String(x).toLowerCase();
const hex = (n) => '0x' + n.toString(16);
const hash = (x) => /^0x[0-9a-f]{64}$/i.test(x ?? '');
const cidOf = (x) => {
  const cid = String(x ?? '').replace(/^ipfs:\/\//, '');
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,110})$/.test(cid) ? cid : null;
};
const text = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';
export function narrativeSources(value, uri, at) {
  const sources = [],
    description = text(value?.description, 1600);
  if (description)
    sources.push({
      id: 'project-description',
      kind: 'project-self-report',
      independent: false,
      uri,
      at,
      text: description,
    });
  for (const k of ['website', 'twitter', 'telegram']) {
    const raw = value?.[k];
    if (typeof raw !== 'string' || raw.length > 512) continue;
    try {
      const u = new URL(raw);
      if (
        u.protocol !== 'https:' ||
        u.username ||
        u.password ||
        u.hostname === 'localhost' ||
        u.hostname.endsWith('.local') ||
        u.hostname.startsWith('[') ||
        /^\d+(\.\d+){3}$/.test(u.hostname)
      )
        continue;
      sources.push({
        id: 'project-' + k,
        kind: 'project-link-unverified',
        independent: false,
        uri,
        at,
        text: u.href,
      });
    } catch {
      /* An arbitrary link never becomes fetched content or verified social activity. */
    }
  }
  return sources;
}
export function turnoverRows(logs, route, from, to, token0) {
  if (!Array.isArray(logs) || logs.length > 10000) throw Error('成交样本无效或过大');
  const seen = new Set(),
    rows = [];
  for (const log of logs) {
    if (log.removed) continue;
    const block = Number(BigInt(log.blockNumber ?? '-1'));
    if (
      String(log.address).toLowerCase() !==
        (route.kind === 'pons-v2'
          ? route.curve
          : route.kind === 'v4'
            ? CHAIN_CONFIG.robinhood.v4Manager
            : route.kind === 'flap'
              ? FLAP
              : route.pool) ||
      !hash(log.blockHash) ||
      !hash(log.transactionHash) ||
      !/^0x[0-9a-f]+$/i.test(log.logIndex ?? '') ||
      !Number.isSafeInteger(block) ||
      block < from ||
      block > to
    )
      throw Error('成交事件身份或范围无效');
    const key = [log.blockHash, log.transactionHash, log.logIndex].join(':');
    if (seen.has(key)) throw Error('成交事件重复');
    seen.add(key);
    if (route.kind === 'v4' && lower(log.topics[1]) !== lower(poolId(route.key)))
      throw Error('成交池身份不匹配');
    const abi =
        route.kind === 'pons-v2'
          ? [PONS_EVENTS[1], PONS_EVENTS[2]]
          : route.kind === 'v4'
            ? [PONS_EVENTS[3]]
            : route.kind === 'flap'
              ? FLAP_EVENTS
              : [SWAPS[route.kind === 'v2' ? 0 : 1]],
      e = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }),
      a = e.args;
    let raw, buy;
    if (route.kind === 'pons-v2') {
      if (!['CurveBuy', 'CurveSell'].includes(e.eventName)) throw Error('曲线成交类型不匹配');
      buy = e.eventName === 'CurveBuy';
      raw = buy ? a.quoteIn : a.quoteOut;
    } else if (route.kind === 'v4') {
      const amount = route.key.currency0 === route.quote ? a.amount0 : a.amount1;
      raw = amount < 0n ? -amount : amount;
      buy = amount < 0n;
    } else if (route.kind === 'flap') {
      if (!['TokenBought', 'TokenSold'].includes(e.eventName)) throw Error('曲线成交类型不匹配');
      if (a.token.toLowerCase() !== route.token) continue;
      raw = a.eth;
      buy = e.eventName === 'TokenBought';
    } else {
      const q0 = token0 !== route.token;
      if (route.kind === 'v2') {
        const input = q0 ? a.amount0In : a.amount1In,
          output = q0 ? a.amount0Out : a.amount1Out;
        if (input > 0n === output > 0n) throw Error('交易报价方向无效');
        raw = input + output;
        buy = input > 0n;
      } else {
        const amount = q0 ? a.amount0 : a.amount1;
        raw = amount < 0n ? -amount : amount;
        buy = amount > 0n;
      }
    }
    if (raw < 0n) throw Error('成交数量无效');
    rows.push({ block, quoteRaw: String(raw), buy });
  }
  return rows;
}
// Exact timestamp boundary, fixed canonical end block and one quote-side amount
// per swap. This is a proved lower bound in the current five minutes, not a
// 24h statistic, a fixed block-count proxy or a claim about wash-trade quality.
export class BuiltinEntryEvidence {
  constructor(store, market, { now = Date.now } = {}) {
    Object.assign(this, { store, market, now });
    this.rpc = market.rpc;
    this.samples = new Map();
    this.pending = new Map();
  }
  snapshot(token) {
    const v = this.store.get('builtin-entry-evidence', token);
    return {
      policyVersion: 1,
      volume5m: v?.volume5m ?? null,
      eligibility: volumeEligibility(v?.volume5m, this.now()),
      narrative: v?.narrative ?? {
        state: 'unknown',
        sources: [],
        limitations: ['未取得可核对的项目叙事资料；不能仅凭名称认定热点。'],
      },
    };
  }
  async collect(token, { narrative = true } = {}) {
    const volume5m = await this.volume(token).catch((e) => {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      return null;
    });
    const old = this.store.get('builtin-entry-evidence', token);
    const n =
      narrative && volumeEligibility(volume5m, this.now()).allowed
        ? await this.narrative(token)
        : old?.narrative;
    this.store.put('builtin-entry-evidence', { id: token, volume5m, narrative: n ?? null });
    return this.snapshot(token);
  }
  async assert(token) {
    const v = await this.collect(token, { narrative: false });
    assertVolume5m(v.volume5m, this.now());
  }
  async volume(token) {
    const market = this.market.getMarket(this.market.chain ?? 'bsc', token);
    if (
      !market ||
      market.quality !== 'verified' ||
      !(market.quoteUsd > 0) ||
      this.now() < market.updatedAt ||
      this.now() - market.updatedAt >= 15000
    )
      throw Error('报价资产换算已过期');
    const route = await this.market.route(this.market.chain ?? 'bsc', token, this.market.head.head);
    if (!['flap', 'v2', 'v3', 'pons-v2', 'v4'].includes(route.kind))
      throw Error('当前路线的5分钟成交量尚未支持');
    const key =
      route.kind === 'flap'
        ? 'portal'
        : route.kind + ':' + (route.curve ?? (route.key ? poolId(route.key) : route.pool));
    let sample = this.samples.get(key);
    if (!sample || this.now() < sample.at || this.now() - sample.at >= 15000) {
      if (!this.pending.has(key))
        this.pending.set(
          key,
          this.readSample(route).finally(() => this.pending.delete(key)),
        );
      sample = await this.pending.get(key);
      this.samples.set(key, sample);
      while (this.samples.size > 64) this.samples.delete(this.samples.keys().next().value);
    }
    const anchor = await this.rpc.block(sample.to.number, true);
    if (anchor.hash !== sample.to.hash) {
      this.samples.delete(key);
      throw Error('成交观测发生重组');
    }
    const boundaryAt = this.now(),
      from = await this.boundary(sample.from.number, sample.to.number, boundaryAt - 300000);
    const rows = turnoverRows(
      sample.logs.filter((l) => Number(BigInt(l.blockNumber)) >= from.number),
      route,
      from.number,
      sample.to.number,
      ['flap', 'pons-v2', 'v4'].includes(route.kind)
        ? null
        : await this.market.venues[this.market.chain ?? 'bsc'].poolToken0(route, sample.to.number),
    );
    const qd = await this.market.venues[this.market.chain ?? 'bsc'].decimals(
        route.quote,
        sample.to.number,
      ),
      raw = rows.reduce((n, r) => n + BigInt(r.quoteRaw), 0n),
      usd = (Number(raw) / 10 ** qd) * market.quoteUsd;
    if (!Number.isFinite(usd) || usd < 0) throw Error('成交量换算无效');
    return {
      windowMs: 300000,
      quality: 'observed-lower-bound',
      usd,
      quoteRaw: String(raw),
      quote: route.quote,
      quoteDecimals: qd,
      quoteUsd: market.quoteUsd,
      conversionAt: market.updatedAt,
      conversionBasis: 'current-executable-quote',
      fromBlock: from.number,
      toBlock: sample.to.number,
      fromTime: from.time,
      toTime: sample.to.time,
      blockHash: sample.to.hash,
      at: sample.at,
      boundaryAt,
      buys: rows.filter((r) => r.buy).length,
      sells: rows.filter((r) => !r.buy).length,
      source:
        route.kind === 'pons-v2'
          ? 'Pons V2 CurveBuy / CurveSell events'
          : route.kind === 'flap'
            ? 'Flap Portal events'
            : 'canonical-pool Swap events',
    };
  }
  async boundary(lo, hi, cutoff) {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2),
        b = await this.rpc.block(mid);
      if (b.time < cutoff) lo = mid + 1;
      else hi = mid;
    }
    return this.rpc.block(lo);
  }
  async readSample(route) {
    const head = await this.rpc.block(),
      to = await this.rpc.block(Math.max(0, head.number - 4), true),
      at = this.now();
    if (to.time > at || at - to.time >= 15000) throw Error('成交观测链头已过期');
    let lo = Math.max(0, to.number - 1024),
      start = await this.rpc.block(lo);
    for (
      let i = 0;
      start.time > at - 300000 && lo > 0 && i < (this.market.chain === 'robinhood' ? 8 : 2);
      i++
    ) {
      lo = Math.max(0, lo - 2048);
      start = await this.rpc.block(lo);
    }
    if (start.time > at - 300000) throw Error('成交观测窗口不足');
    const from = await this.boundary(lo, to.number, at - 300000);
    if (to.number - from.number > (this.market.chain === 'robinhood' ? 19999 : 3999))
      throw Error('成交窗口超过单轮读取上限');
    const topics =
      route.kind === 'pons-v2'
        ? [getEventSelector(PONS_EVENTS[1]), getEventSelector(PONS_EVENTS[2])]
        : route.kind === 'v4'
          ? [getEventSelector(PONS_EVENTS[3])]
          : route.kind === 'flap'
            ? [getEventSelector(FLAP_EVENTS[1]), getEventSelector(FLAP_EVENTS[2])]
            : [getEventSelector(SWAPS[route.kind === 'v2' ? 0 : 1])];
    const logs = [];
    for (let b = from.number; b <= to.number; b += 1000) {
      const page = await this.rpc.request('eth_getLogs', [
        {
          address:
            route.kind === 'pons-v2'
              ? route.curve
              : route.kind === 'v4'
                ? CHAIN_CONFIG.robinhood.v4Manager
                : route.kind === 'flap'
                  ? FLAP
                  : route.pool,
          fromBlock: hex(b),
          toBlock: hex(Math.min(to.number, b + 999)),
          topics: route.kind === 'v4' ? [topics, poolId(route.key)] : [topics],
        },
      ]);
      if (!Array.isArray(page) || page.length > 10000 || logs.length + page.length > 10000)
        throw Error('成交事件过大');
      logs.push(...page);
    }
    if ((await this.rpc.block(to.number, true)).hash !== to.hash) throw Error('成交观测发生重组');
    return { from, to, at, logs };
  }
  async narrative(token) {
    const old = this.store.get('builtin-entry-evidence', token)?.narrative;
    if (old && this.now() >= old.at && this.now() - old.at < (old.sources.length ? 1800000 : 60000))
      return old;
    let sources = [];
    const data = this.market.memeData;
    if (data?.narrative) return data.narrative(token);
    try {
      if (data?.flap.supports(token)) {
        let cid = cidOf(this.store.get('cloud-flap-launches', token)?.metadataCid);
        if (!cid)
          cid = cidOf(await this.rpc.read(token, META, 'metaURI', [], this.market.head.head));
        if (cid) {
          const budget = this.store.get('cloud-settings', 'narrative-ipfs-budget');
          if (this.now() < (budget?.retryAt ?? 0)) throw Error('项目介绍来源暂不可用');
          const uri = 'https://flap.mypinata.cloud/ipfs/' + cid;
          const r = await data.fetch(uri, {
            redirect: 'manual',
            signal: AbortSignal.timeout(8000),
            headers: { Accept: 'application/json' },
          });
          if (!r.ok) {
            const retry = retryAfter(r.headers.get('Retry-After'), this.now());
            this.store.put('cloud-settings', {
              id: 'narrative-ipfs-budget',
              retryAt: Math.max(this.now() + (r.status === 429 ? 300000 : 60000), retry.at ?? 0),
            });
            await r.body?.cancel().catch(() => {});
            throw Error('项目介绍未取得');
          }
          if (Number(r.headers.get('Content-Length')) > 32768) {
            await r.body?.cancel().catch(() => {});
            throw Error('项目介绍过大');
          }
          const reader = r.body.getReader(),
            chunks = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 32768) throw Error('项目介绍过大');
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          sources = narrativeSources(JSON.parse(new TextDecoder().decode(bytes)), uri, this.now());
        }
      } else if (data) {
        const d = await data.chart(token),
          p = d.pair;
        sources = narrativeSources(
          {
            description: p.info?.description,
            website: p.info?.websites?.[0]?.url,
            twitter: p.info?.socials?.find((s) => s.type === 'twitter')?.url,
          },
          'https://dexscreener.com/bsc/' + p.pairAddress,
          d.at,
        );
      }
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
    }
    return {
      at: this.now(),
      state: sources.length ? 'project-material-only' : 'unknown',
      sources,
      limitations: [
        '项目自述和链接不能证明官方背书、实时热度或传播强度。',
        '未独立核实社交传播、同名来源和事件关联；名称与涨幅不能充当证明。',
      ],
    };
  }
}
