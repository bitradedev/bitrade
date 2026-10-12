import { RISK_POLICY } from '../bi-trade/lib/token-risk-core.mjs';
import { runProposalRound } from './proposal-round.mjs';
import { startShowcaseDecision, runDecisionRound } from './decision-round.mjs';
function riskDue(host, token) {
  const row = host.store.get?.('token-risk-reports', token);
  return (
    !row ||
    !Number.isFinite(row.fetchedAt) ||
    Date.now() < row.fetchedAt ||
    Date.now() - row.fetchedAt >= RISK_POLICY.maxAgeMs
  );
}
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
        dueExits = app.showcase.exitCandidates?.().length,
        retry = host.store.get?.('cloud-settings', 'exit-priority-round');
      if (
        !app.showcase.watching &&
        (failedExits || dueExits) &&
        Date.now() - (retry?.at ?? 0) >= 30000
      ) {
        host.store.put('cloud-settings', { id: 'exit-priority-round', at: Date.now() });
        await host.market.updateHead();
        await host.market.fx();
        // Rotate all due held accounts, including those that have never failed.
        // Repeated risk continuations must not postpone their first stop check.
        await app.showcase.watchExits({ onlyFailures: false });
        host.store.put('cloud-settings', {
          id: 'scheduler',
          at: Date.now(),
          ok: !host.io.exhausted,
          phase: 'exits',
          ...(host.io.exhausted
            ? { reason: '本轮退出核价预算已用完，持仓将在后续轮次继续核对' }
            : {}),
        });
        return;
      }
      const proposal = app.showcase.pendingProposal?.();
      if (proposal && !host.decisionTask) {
        await runProposalRound(host, app, proposal);
        return;
      }
      if (
        !host.decisionTask &&
        app.showcase.decisionDue?.() &&
        host.market.marketScope?.()?.kind === 'meme'
      ) {
        const permitted = host.market
          .markets()
          .find(
            (m) =>
              host.market.isEntryCandidate(m.address) &&
              host.risk.snapshot(m.address, m.priceUsd).buyAllowed,
          );
        if (permitted) {
          // Refresh and evaluate a currently permitted token before unrelated
          // risk continuations spend its short evidence-validity window.
          await runDecisionRound(host, app, permitted);
          return;
        }
      }
      const tokens = [
        ...new Set(
          host.store
            .all('paper-lots')
            .filter((l) => BigInt(l.remainingRaw) > 0n)
            .map((l) => l.token),
        ),
      ];
      const pendingRisk = host.store.get?.('cloud-settings', 'risk-priority-round');
      if (pendingRisk?.tokens?.length && !host.decisionTask) {
        const requested = pendingRisk.tokens.filter(
          (token) =>
            /^0x[0-9a-f]{40}$/i.test(token) &&
            (tokens.includes(token) || host.market.isEntryCandidate(token)),
        );
        await host.market.updateHead();
        await host.market.fx();
        const task = requested.length ? host.risk.tick(requested) : null;
        await task;
        host.store.put('cloud-settings', {
          id: 'risk-priority-round',
          at: Date.now(),
          // A completed source check may legitimately retain an old chart age.
          // Do not pin discovery forever on that token. Only local exhaustion
          // or the risk collector's short pacing window keeps this continuation.
          tokens: requested.length && (!task || host.io.exhausted) ? requested : [],
        });
        host.store.put('cloud-settings', {
          id: 'scheduler',
          at: Date.now(),
          ok: !host.io.exhausted,
          phase: 'risk',
          ...(host.io.exhausted
            ? { reason: '本轮请求预算已用完，风险资料将在下一轮继续核对' }
            : {}),
        });
        return;
      }
      await host.market.refresh(tokens, { limit: 1 });
      await app.paper.tick();
      if (!host.decisionTask) {
        const fresh = app.showcase.freshMarkets();
        const riskTokens =
          host.market.marketScope?.()?.kind === 'meme'
            ? [
                ...fresh.sort((a, b) => b.updatedAt - a.updatedAt).map((m) => m.address),
                ...tokens.filter((token) => host.market.isEntryCandidate(token)),
              ]
            : [...tokens, ...fresh.map((m) => m.address)];
        const due = riskTokens.find((token) => riskDue(host, token));
        if (
          due &&
          host.market.marketScope?.()?.kind === 'meme' &&
          host.io.remaining < (host.riskRequestReserve ?? 0)
        ) {
          // Never start a fresh proof in the leftovers of an expensive chart
          // round. Persist its identity; a new alarm has its own bounded budget.
          host.store.put('cloud-settings', {
            id: 'risk-priority-round',
            at: Date.now(),
            tokens: [due],
          });
          host.store.put('cloud-settings', {
            id: 'scheduler',
            at: Date.now(),
            ok: !host.io.exhausted,
            phase: 'risk-deferred',
          });
          return;
        }
        await host.risk.tick(riskTokens);
      }
      await host.market.pulse(1);
      if (host.decisionTask) await app.showcase.watchExits();
      else startShowcaseDecision(host, app);
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
