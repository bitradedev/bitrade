export async function runScheduledRound(host) {
  await host.ctx.storage.setAlarm(Date.now() + 10000);
  if (host.importing) return;
  if (host.working) return host.working;
  host.working = (async () => {
    try {
      const app = await host.initialize();
      if (app.paper.orders().some((o) => o.status === 'queued')) {
        await host.market.updateHead();
        await host.market.fx();
        await app.paper.tick();
        host.store.put('cloud-settings', {
          id: 'scheduler',
          at: Date.now(),
          ok: true,
          phase: 'matching',
        });
        return;
      }
      const failedExits = host.store.all('showcase-status').some((s) => s.exitFailures?.length),
        retry = host.store.get?.('cloud-settings', 'exit-priority-round');
      if (failedExits && Date.now() - (retry?.at ?? 0) >= 30000) {
        host.store.put('cloud-settings', { id: 'exit-priority-round', at: Date.now() });
        await host.market.updateHead();
        await host.market.fx();
        await app.showcase.watchExits({ onlyFailures: true });
        host.store.put('cloud-settings', {
          id: 'scheduler',
          at: Date.now(),
          ok: true,
          phase: 'exits',
        });
        return;
      }
      const tokens = [
        ...new Set(
          host.store
            .all('paper-lots')
            .filter((l) => BigInt(l.remainingRaw) > 0n)
            .map((l) => l.token),
        ),
      ];
      await host.market.refresh(tokens, { limit: 1 });
      await app.paper.tick();
      if (!host.decisionTask) {
        const fresh = app.showcase.freshMarkets();
        const riskTokens =
          host.market.marketScope?.()?.kind === 'meme'
            ? fresh.sort((a, b) => b.updatedAt - a.updatedAt).map((m) => m.address)
            : [...tokens, ...fresh.map((m) => m.address)];
        await host.risk.tick(riskTokens);
      }
      await host.market.pulse(1);
      if (host.decisionTask) await app.showcase.watchExits();
      else {
        const task = app.showcase.tick();
        if (task) {
          const tracked = host.io.trackDecision(task);
          host.decisionTask = tracked;
          // Keep the same invocation's budget for all work after the model
          // response. A new alarm gets a new budget, not this existing task.
          host.ctx.waitUntil(
            tracked
              .finally(async () => {
                if (host.decisionTask === tracked) host.decisionTask = null;
                await host.arm(1000);
              })
              .catch(() => {}),
          );
        }
      }
      await host.risk.task;
      host.store.prune();
      host.store.put('cloud-settings', { id: 'scheduler', at: Date.now(), ok: true });
    } catch {
      host.store.put('cloud-settings', {
        id: 'scheduler',
        at: Date.now(),
        ok: false,
        reason: '本轮行情或模拟调度未完成，将自动重试',
      });
    } finally {
      host.working = null;
      await host.arm(host.app?.paper.orders().some((o) => o.status === 'queued') ? 1000 : 10000);
    }
  })();
  return host.working;
}
