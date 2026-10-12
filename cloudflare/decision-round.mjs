export function startShowcaseDecision(host, app, options) {
  const task = app.showcase.tick(options);
  if (!task) return false;
  const tracked = host.io.trackDecision(task);
  host.decisionTask = tracked;
  host.ctx.waitUntil(
    tracked
      .finally(async () => {
        if (host.decisionTask === tracked) host.decisionTask = null;
        await host.arm(1000);
      })
      .catch(() => {}),
  );
  return true;
}
export async function runDecisionRound(host, app, market, held = null) {
  await host.market.refresh([market.address], { limit: 1, onlyRequested: true });
  const permitted = app.showcase
    .freshMarkets()
    .some((m) => host.risk.snapshot(m.address, m.priceUsd).buyAllowed);
  const quote = host.market.getMarket?.('bsc', market.address),
    heldFresh =
      held &&
      quote?.quality === 'verified' &&
      Date.now() - quote.updatedAt >= 0 &&
      Date.now() - quote.updatedAt < 15000;
  const started =
    !host.io.exhausted && host.io.remaining >= 2 && (held ? heldFresh : permitted)
      ? startShowcaseDecision(host, app, held ? { agentId: held.agentId } : undefined)
      : false;
  host.store.put('cloud-settings', {
    id: 'scheduler',
    at: Date.now(),
    phase: 'decision-priority',
    ok: !host.io.exhausted,
  });
  return started;
}
