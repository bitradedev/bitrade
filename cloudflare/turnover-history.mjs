const DAY = 86400000;
function total(segments) {
  return segments.reduce(
    (v, s) => ({
      quoteRaw: v.quoteRaw + BigInt(s.quoteRaw),
      buys: v.buys + s.buys,
      sells: v.sells + s.sells,
    }),
    { quoteRaw: 0n, buys: 0, sells: 0 },
  );
}
function compress(segments) {
  const rows = [];
  for (const s of [...segments].sort((a, b) => a.fromBlock - b.fromBlock)) {
    const p = rows.at(-1);
    if (
      p &&
      p.toBlock + 1 === s.fromBlock &&
      Math.floor(p.fromTime / 3600000) === Math.floor(s.fromTime / 3600000)
    ) {
      const v = total([p, s]);
      rows[rows.length - 1] = {
        ...p,
        toBlock: s.toBlock,
        toTime: s.toTime,
        blockHash: s.blockHash,
        quoteRaw: String(v.quoteRaw),
        buys: v.buys,
        sells: v.sells,
      };
    } else rows.push(s);
  }
  // Keeping a smaller set only undercounts real observations, never pads them.
  return rows.slice(-64);
}
function gap(segments, toBlock) {
  let end = toBlock;
  for (const s of [...segments].sort((a, b) => b.toBlock - a.toBlock)) {
    if (s.fromBlock <= end && s.toBlock >= end) end = s.fromBlock - 1;
    else if (s.toBlock < end) return { from: Math.max(s.toBlock + 1, end - 999), to: end };
  }
  return end >= 0 ? { from: Math.max(0, end - 999), to: end } : null;
}
export async function readTurnoverHistory(reader, pool, b, quote0, nativeUsd, topic, parseLogs) {
  const { store, rpc } = reader,
    now = () => reader.now(),
    id = 'meme-turnover:' + pool,
    old = store.get('cloud-public-cache', id),
    saved = store.get('cloud-meme-turnover', pool);
  if (
    old &&
    now() - old.at >= 0 &&
    now() - old.at < 60000 &&
    old.toBlock <= b.number &&
    now() - old.fromTime < DAY
  ) {
    const anchor = await rpc.block(old.toBlock, true);
    if (anchor.hash === old.blockHash) return old;
  }
  const toBlock = Math.max(0, b.number - 4);
  let segments = (saved?.segments ?? (old ? [old] : [])).filter(
    (s) =>
      Number.isSafeInteger(s.fromBlock) &&
      Number.isSafeInteger(s.toBlock) &&
      s.fromBlock >= 0 &&
      s.fromBlock <= s.toBlock &&
      s.toBlock <= toBlock &&
      Number.isFinite(s.fromTime) &&
      now() - s.fromTime >= 0 &&
      now() - s.fromTime < DAY &&
      /^\d+$/.test(s.quoteRaw ?? '') &&
      Number.isSafeInteger(s.buys) &&
      s.buys >= 0 &&
      Number.isSafeInteger(s.sells) &&
      s.sells >= 0,
  );
  segments = compress(segments);
  if (segments.length) {
    const last = segments.at(-1),
      anchor = await rpc.block(last.toBlock, true);
    if (anchor.hash !== last.blockHash) segments = [];
  }
  let pages = 0,
    lastSample = null,
    recentSample = null,
    backfillRetryAt = saved?.backfillRetryAt ?? 0;
  async function collect(from, to) {
    const [start, before] = await Promise.all([rpc.block(from), rpc.block(to, true)]);
    if (!Number.isFinite(start.time) || now() < start.time || now() - start.time >= DAY)
      return false;
    const logs = await rpc.request('eth_getLogs', [
        {
          address: pool,
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
          topics: [topic],
        },
      ]),
      v = parseLogs(logs, pool, from, to, quote0),
      after = await rpc.block(to, true);
    if (before.hash !== after.hash) throw Error('换手样本期间区块重组，需要重新读取');
    const segment = {
      fromBlock: from,
      toBlock: to,
      fromTime: start.time,
      toTime: before.time,
      blockHash: after.hash,
      quoteRaw: String(v.quoteRaw),
      buys: v.buys,
      sells: v.sells,
    };
    if (segments.some((s) => from <= s.toBlock && to >= s.fromBlock))
      throw Error('换手采样区间重叠');
    segments = compress([...segments, segment]);
    lastSample = segment;
    if (to === toBlock) recentSample = segment;
    pages++;
    store.put('cloud-meme-turnover', { id: pool, at: now(), segments, backfillRetryAt });
    return true;
  }
  const last = segments.at(-1);
  if (!last || last.toBlock < toBlock)
    await collect(Math.max(last?.toBlock + 1 || 0, toBlock - 999), toBlock);
  // Advance the real observed lower bound across invocations, without querying
  // a large forbidden span or duplicating an overlapping historical window.
  while (
    pages < 3 &&
    (Number(total(segments).quoteRaw) / 1e18) * nativeUsd < 1000 &&
    now() >= backfillRetryAt
  ) {
    const range = gap(segments, toBlock);
    if (!range) break;
    try {
      if (!(await collect(range.from, range.to))) break;
    } catch (e) {
      if (e?.code === 'CF_SUBREQUEST_BUDGET') throw e;
      if (!e?.rpcUnavailable) throw e;
      backfillRetryAt = now() + 300000;
      store.put('cloud-meme-turnover', { id: pool, at: now(), segments, backfillRetryAt });
      // Known latest samples remain a partial lower bound, not a completed day.
      break;
    }
  }
  if (!segments.length) throw Error('近24小时没有可核实的池成交样本');
  const first = segments[0],
    tip = segments.at(-1),
    v = total(segments),
    row = {
      id,
      at: lastSample ? now() : (old?.at ?? saved?.at ?? now()),
      fromBlock: first.fromBlock,
      toBlock: tip.toBlock,
      fromTime: first.fromTime,
      blockHash: tip.blockHash,
      quoteRaw: String(v.quoteRaw),
      buys: v.buys,
      sells: v.sells,
      sampledRanges: segments.map((s) => ({
        fromBlock: s.fromBlock,
        toBlock: s.toBlock,
        fromTime: s.fromTime,
        toTime: s.toTime,
      })),
      hasGaps: segments.some((s, i) => i > 0 && s.fromBlock !== segments[i - 1].toBlock + 1),
      latestSample: recentSample
        ? {
            fromBlock: recentSample.fromBlock,
            toBlock: recentSample.toBlock,
            buys: recentSample.buys,
            sells: recentSample.sells,
          }
        : null,
    };
  store.put('cloud-public-cache', row);
  return row;
}
