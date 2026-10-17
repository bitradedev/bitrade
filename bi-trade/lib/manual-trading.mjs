import { address } from './auth.mjs';
import { digest, identifier, fail, fields, raw } from './database-core.mjs';

const pending = new Set(['preparing', 'queued', 'quoting']);
const outsideRaw = (q) =>
  BigInt(Math.ceil(((q.fees.gasUsd + q.fees.approvalUsd) / q.nativeUsd) * 1e18));

export function createManualTrading({
  store,
  paper,
  vault,
  gateway,
  network,
  execute,
  visibleOrder,
}) {
  const accountId = (session) =>
    'manual-' + digest(network.chain + ':' + session.owner.id).slice(0, 32);
  function agent(session, required = true) {
    const a = store.get('agents', accountId(session));
    if (!a && !required) return null;
    if (
      !a ||
      a.ownerId !== session.owner.id ||
      a.source !== 'manual' ||
      a.mode !== 'paper' ||
      a.closedAt
    )
      throw fail('请先开启手动模拟账户', 409);
    return a;
  }
  function marketDto(m) {
    if (!m || m.chain !== network.chain) return null;
    return {
      token: m.address,
      symbol: String(m.symbol ?? m.address.slice(0, 10)).slice(0, 60),
      name: String(m.name ?? '').slice(0, 100),
      priceUsd: Number.isFinite(m.priceUsd) ? m.priceUsd : null,
      at: m.updatedAt ?? null,
      stage: m.stage ?? null,
      quoteSymbol: m.quoteSymbol ?? 'ETH',
      reserveUsd: m.reserveUsd ?? null,
      liquidityUsd: m.liquidityUsd ?? null,
      progressPct: m.progressPct ?? null,
      buyTaxPct: m.buyTaxPct ?? null,
      sellTaxPct: m.sellTaxPct ?? null,
      fresh:
        m.quality === 'verified' && Date.now() >= m.updatedAt && Date.now() - m.updatedAt < 15000,
    };
  }
  function markets() {
    return {
      network,
      markets: gateway
        .markets()
        .filter((m) => m.chain === network.chain && m.platform === 'pons-v2')
        .sort((a, b) => (b.createdAt ?? b.discoveredAt ?? 0) - (a.createdAt ?? a.discoveredAt ?? 0))
        .slice(0, 96)
        .map(marketDto),
    };
  }
  function view(session) {
    const a = agent(session, false);
    if (!a) return { network, account: null, positions: [], orders: [], fills: [] };
    const account = paper.view(a.id),
      grouped = new Map();
    for (const lot of account.positions) {
      let p = grouped.get(lot.token);
      if (!p)
        grouped.set(
          lot.token,
          (p = {
            token: lot.token,
            symbol: lot.symbol,
            decimals: lot.decimals,
            remainingRaw: '0',
            costUsd: 0,
            estimatedValueUsd: 0,
          }),
        );
      p.remainingRaw = String(BigInt(p.remainingRaw) + BigInt(lot.remainingRaw));
      p.costUsd += lot.usdCost;
      p.estimatedValueUsd =
        p.estimatedValueUsd === null || lot.estimatedValueUsd === null
          ? null
          : p.estimatedValueUsd + lot.estimatedValueUsd;
    }
    const orders = paper.orders(a.id),
      seen = new Set(orders.map((o) => o.id));
    orders.push(...store.forAgent('requests', a.id).filter((o) => !seen.has(o.id)));
    return {
      network,
      account: {
        id: a.id,
        initialUsd: account.initialUsd,
        balanceWei: account.balanceWei,
        balanceUsd: account.balanceUsd,
        realizedUsd: account.realizedUsd,
        feesUsd: account.feesUsd,
        pending: account.pending,
        createdAt: account.createdAt,
      },
      positions: [...grouped.values()],
      orders: orders
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50)
        .map((o) => ({
          id: o.id,
          token: o.token ?? null,
          side: o.side ?? (o.action === 'sell_token' ? 'sell' : 'buy'),
          status: o.status,
          createdAt: o.createdAt,
          canCancel: pending.has(o.status),
          failed: o.status === 'failed',
        })),
      fills: paper
        .fills(a.id)
        .sort((a, b) => b.at - a.at)
        .slice(0, 100)
        .map((f) => ({
          id: f.id,
          orderId: f.orderId,
          token: f.token,
          side: f.side,
          at: f.at,
          tokenRaw: f.tokenRaw,
          decimals: store.get('paper-orders', f.orderId)?.quote?.tokenDecimals ?? null,
          nativeRaw: f.nativeRaw,
          usd: f.usd,
          netUsd: f.side === 'sell' ? f.netUsd : null,
          block: f.block,
          fees: {
            gasUsd: f.fees?.gasUsd,
            approvalUsd: f.fees?.approvalUsd,
            protocolUsd: f.fees?.protocolUsd,
            taxUsd: f.fees?.taxUsd,
            conversionUsd: f.fees?.conversionUsd,
          },
        })),
    };
  }
  function start(session) {
    if (paper.readOnly) throw fail('模拟交易暂时不可用，请稍后重试', 503);
    if (network.chain !== 'robinhood') throw fail('手动模拟当前只支持 Robinhood Chain', 409);
    store.transaction(() => {
      if (agent(session, false)) return;
      const id = accountId(session);
      store.put('agents', {
        id,
        ownerId: session.owner.id,
        name: 'Manual paper trading',
        source: 'manual',
        ...vault.create(id),
        mode: 'paper',
        paused: false,
        public: false,
        createdAt: Date.now(),
        policy: { mode: 'balance' },
      });
      paper.account(id);
      const fx = paper.fx();
      if (fx) paper.seed(id, fx);
      store.audit(
        session.owner.id,
        id,
        'manual-start',
        '独立手动模拟账户创建，初始1000USD；未使用真实资金',
      );
    });
    return view(session);
  }
  async function refreshToken(token, entry) {
    try {
      await gateway.updateHead?.();
      await gateway.fx?.();
      if (entry) await gateway.assertExternalEntry(token);
      else await gateway.refresh?.([token], { limit: 1, onlyRequested: true });
      await gateway.updateHead?.();
    } catch {
      throw fail('当前无法确认模拟成交报价，请稍后重试', 503);
    }
  }
  async function lookup(_session, data) {
    fields(data, ['token']);
    const token = address(data.token);
    await refreshToken(token, true);
    const m = marketDto(gateway.getMarket(network.chain, token));
    if (!m?.fresh || !(m.priceUsd > 0)) throw fail('该代币当前没有可用的模拟报价', 503);
    const points = (store.get('market-tapes', token)?.samples ?? [])
      .map((s) => ({ at: s.sourceAt ?? s.at, priceUsd: s.priceUsd }))
      .filter(
        (s) =>
          Number.isFinite(s.at) &&
          s.at <= Date.now() &&
          Date.now() - s.at < 6 * 3600000 &&
          Number.isFinite(s.priceUsd) &&
          s.priceUsd > 0,
      );
    points.push({ at: m.at, priceUsd: m.priceUsd });
    return {
      market: m,
      points: [...new Map(points.map((p) => [p.at, p])).values()]
        .sort((a, b) => a.at - b.at)
        .slice(-120),
    };
  }
  async function preview(session, data) {
    fields(data, ['token', 'side', 'amount', 'unit', 'percent']);
    const a = agent(session),
      token = address(data.token),
      side = data.side;
    if (!['buy', 'sell'].includes(side)) throw fail('请选择买入或卖出');
    await refreshToken(token, side === 'buy');
    const fx = paper.fx();
    if (!fx) throw fail('当前价格暂不可用，请稍后重试', 503);
    const account = paper.seed(a.id, fx);
    let amount;
    if (side === 'buy') {
      if (
        !['USD', 'ETH'].includes(data.unit) ||
        typeof data.amount !== 'string' ||
        !/^\d{1,12}(?:\.\d{1,18})?$/.test(data.amount)
      )
        throw fail('请输入有效的买入金额');
      const n = Number(data.amount);
      if (!Number.isFinite(n) || n <= 0) throw fail('买入金额必须大于零');
      if (data.unit === 'ETH') {
        const [whole, fraction = ''] = data.amount.split('.');
        amount = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
      } else amount = BigInt(Math.floor((n / fx) * 1e18));
    } else {
      const held = paper
        .lots(a.id)
        .filter((p) => p.token === token)
        .reduce((n, p) => n + BigInt(p.remainingRaw), 0n);
      if (data.percent !== undefined) {
        if (!Number.isInteger(data.percent) || data.percent < 1 || data.percent > 100)
          throw fail('卖出比例须为1至100');
        amount = (held * BigInt(data.percent)) / 100n;
      } else {
        amount = raw(data.amount);
        if (amount > held) throw fail('卖出数量超过模拟持仓');
      }
    }
    raw(String(amount));
    let q;
    try {
      q = await paper.quote(a, side, token, String(amount), paper.head().head);
      if (side === 'buy') {
        const reverse = await paper.quote(a, 'sell', token, q.outputRaw, q.block);
        if (reverse.spentInputRaw !== reverse.inputRaw) throw Error('Unverified reverse');
      }
    } catch {
      throw fail('当前无法确认模拟成交报价，请稍后重试', 503);
    }
    const fees = outsideRaw(q);
    if (side === 'buy' && BigInt(q.spentInputRaw) + fees > BigInt(account.nativeRaw))
      throw fail('虚拟余额不足，请为费用预留余额');
    if (side === 'sell' && BigInt(account.nativeRaw) + BigInt(q.outputRaw) < fees)
      throw fail('虚拟余额不足以支付卖出费用');
    if (Date.now() - q.at > 5000) throw fail('报价已过期，请重新报价', 409);
    const p = {
      id: identifier(),
      agentId: a.id,
      token,
      side,
      amount: String(amount),
      outputRaw: q.outputRaw,
      tokenDecimals: q.tokenDecimals,
      nativeUsd: q.nativeUsd,
      priceUsd: q.priceUsd,
      priceImpactPct: q.priceImpactPct ?? null,
      fees: q.fees,
      inputUsd: side === 'buy' ? (Number(BigInt(q.spentInputRaw)) / 1e18) * q.nativeUsd : null,
      outputUsd: side === 'sell' ? (Number(BigInt(q.outputRaw)) / 1e18) * q.nativeUsd : null,
      outsideFeesUsd: q.fees.gasUsd + q.fees.approvalUsd,
      at: q.at,
      expiresAt: q.at + 15000,
      block: q.block,
      slippageBps: 3000,
    };
    store.put('manual-previews', p);
    // Keep only a small recent set; never prune orders, fills or ledger entries.
    for (const old of store
      .forAgent('manual-previews', a.id)
      .sort((a, b) => b.at - a.at)
      .slice(20))
      store.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run('manual-previews', old.id);
    return {
      ...p,
      agentId: undefined,
      fees: {
        gasUsd: q.fees.gasUsd,
        approvalUsd: q.fees.approvalUsd,
        protocolUsd: q.fees.protocolUsd,
        taxUsd: q.fees.taxUsd,
        conversionUsd: q.fees.conversionUsd,
        quality: 'estimated',
      },
    };
  }
  async function submit(session, data) {
    fields(data, ['previewId', 'requestKey']);
    const a = agent(session);
    if (typeof data.requestKey !== 'string' || !/^[\w.:~-]{1,100}$/.test(data.requestKey))
      throw fail('交易请求无效');
    if (typeof data.previewId !== 'string' || !/^[a-f0-9]{32}$/.test(data.previewId))
      throw fail('报价不存在，请重新报价', 404);
    const p = store.get('manual-previews', data.previewId);
    if (!p || p.agentId !== a.id) throw fail('报价不存在，请重新报价', 404);
    if (p.requestKey && p.requestKey !== data.requestKey)
      throw fail('该报价已经提交，请重新报价', 409);
    const old = store.db
      .prepare('SELECT * FROM intents WHERE agent=? AND requestKey=?')
      .get(a.id, data.requestKey);
    if (!old && (Date.now() > p.expiresAt || Date.now() < p.at))
      throw fail('报价已过期，请重新报价', 409);
    if (!p.requestKey) store.put('manual-previews', { ...p, requestKey: data.requestKey });
    try {
      return await execute(a, p.side === 'buy' ? 'buy_token' : 'sell_token', {
        token: p.token,
        amount: p.amount,
        chainId: network.chainId,
        requestKey: data.requestKey,
        minOutput: String((BigInt(p.outputRaw) * 7000n) / 10000n),
        reason: '用户手动提交模拟' + (p.side === 'buy' ? '买入' : '卖出'),
      });
    } catch (e) {
      if (e.status === 409) throw fail('订单尚未完成或报价发生变化，请查看订单后重新报价', 409);
      throw fail('本次模拟订单未完成，请查看订单后重试', e.status === 400 ? 400 : 503);
    }
  }
  function cancel(session, data) {
    fields(data, ['id']);
    if (typeof data.id !== 'string' || data.id.length > 100) throw fail('订单不存在', 404);
    const a = agent(session),
      o = store.get('paper-orders', data.id);
    if (!o || o.agentId !== a.id) throw fail('订单不存在', 404);
    return visibleOrder(paper.cancel(o.id));
  }
  return { view, markets, start, lookup, preview, submit, cancel };
}
