// Match the executor's existing policy: the oldest remaining entry governs the
// entire token position, including later additions. Never infer a missing rule.
export function showcasePositions(store, lots) {
  const grouped = new Map();
  for (const lot of [...lots].sort((a, b) => a.at - b.at)) {
    if (BigInt(lot.remainingRaw) <= 0n) continue;
    const held = grouped.get(lot.token) ?? [];
    held.push(lot);
    grouped.set(lot.token, held);
  }
  return [...grouped].map(([token, held]) => {
    const first = held[0],
      saved =
        store.get('showcase-exits', first.orderId) ??
        store.get('showcase-exits', first.agentId + ':' + token),
      rule = saved
        ? {
            takeProfitPct: saved.takeProfitPct,
            stopLossPct: saved.stopLossPct,
            maxHoldMinutes: saved.maxHoldMinutes,
          }
        : null;
    return {
      token,
      symbol: first.symbol ?? token.slice(0, 10),
      amountRaw: String(held.reduce((n, p) => n + BigInt(p.remainingRaw), 0n)),
      costUsd: held.reduce((n, p) => n + p.usdCost, 0),
      exitPlan: {
        state: rule ? 'active' : 'missing',
        scope: 'entire-token-position',
        basis: 'net-executable-usd-return',
        entryOrderId: first.orderId,
        openedAt: first.at,
        deadlineAt: rule ? first.at + rule.maxHoldMinutes * 60000 : null,
        rule,
      },
    };
  });
}
