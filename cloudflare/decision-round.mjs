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
  const peers =
    host.marketPolicy?.selfHosted && !held
      ? (host.market.prioritizedEntryMarkets?.() ?? host.market.markets?.() ?? [])
          .filter(
            (m) =>
              host.market.isEntryCandidate(m.address) &&
              host.risk.snapshot(m.address, m.priceUsd).buyAllowed,
          )
          .map((m) => m.address)
      : [];
  const tokens = [...new Set([market.address, ...peers])].slice(
    0,
    host.marketPolicy?.selfHosted && !held ? host.marketPolicy.refreshBatch : 1,
  );
  // Refresh the comparison set together before entry evaluation. Held exits
  // and Cloudflare's small-budget path keep their single-token priority.
  await host.market.refresh(tokens, { limit: tokens.length, onlyRequested: true });
  if (!held && host.market.prepareBuiltinEntries) {
    await host.market.prepareBuiltinEntries(tokens);
    // Source collection must never make old prices look newly quoted.
    await host.market.refresh(tokens, { limit: tokens.length, onlyRequested: true });
  }
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
