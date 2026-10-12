export const EXIT_POLICY_VERSION = 2;
export function exitRule(value) {
  return {
    takeProfitPct: value?.takeProfitPct ?? null,
    stopLossPct: value?.stopLossPct ?? null,
    maxHoldMinutes: value?.maxHoldMinutes ?? null,
  };
}
export const hasAutomaticExit = (rule) =>
  rule && Object.values(rule).some((value) => Number.isFinite(value) && value > 0);

// Explicit AI updates govern the same oldest remaining entry and whole position.
// Legacy frozen rules stay recorded as evidence, not mandatory exit thresholds.
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
      entry =
        store.get('showcase-exits', first.orderId) ??
        store.get('showcase-exits', first.agentId + ':' + token),
      update = store.get('showcase-exit-plan', first.orderId),
      saved = update?.agentId === first.agentId && update?.token === token ? update : entry,
      current = saved?.policyVersion === EXIT_POLICY_VERSION,
      rule = saved ? exitRule(current ? saved : null) : null;
    return {
      token,
      symbol: first.symbol ?? token.slice(0, 10),
      amountRaw: String(held.reduce((n, p) => n + BigInt(p.remainingRaw), 0n)),
      costUsd: held.reduce((n, p) => n + p.usdCost, 0),
      exitPlan: {
        state: hasAutomaticExit(rule) ? 'active' : saved ? 'ai-managed' : 'missing',
        scope: 'entire-token-position',
        basis: 'net-executable-usd-return',
        entryOrderId: first.orderId,
        openedAt: first.at,
        deadlineAt:
          rule?.maxHoldMinutes !== null && rule?.maxHoldMinutes !== undefined
            ? first.at + rule.maxHoldMinutes * 60000
            : null,
        rule,
        previousRule: saved && !current ? exitRule(saved) : null,
        updatedAt: current ? (saved.updatedAt ?? null) : null,
      },
    };
  });
}
