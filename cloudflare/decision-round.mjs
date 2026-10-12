export function startShowcaseDecision(host, app) {
  const task = app.showcase.tick();
  if (!task) return;
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
}
export async function runDecisionRound(host, app, market) {
  await host.market.refresh([market.address], { limit: 1, onlyRequested: true });
  const permitted = app.showcase
    .freshMarkets()
    .some((m) => host.risk.snapshot(m.address, m.priceUsd).buyAllowed);
  if (!host.io.exhausted && host.io.remaining >= 2 && permitted) startShowcaseDecision(host, app);
  host.store.put('cloud-settings', {
    id: 'scheduler',
    at: Date.now(),
    phase: 'decision-priority',
    ok: !host.io.exhausted,
  });
}
