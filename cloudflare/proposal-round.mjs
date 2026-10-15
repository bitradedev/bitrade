import { currentRiskEvidence } from '../bi-trade/lib/token-risk-core.mjs';

async function submitDirect(host, app, proposal) {
  const token = proposal.decision.token;
  await host.market.refresh([token], { limit: 1, onlyRequested: true });
  const market = host.market.getMarket?.('bsc', token);
  if (
    host.io.exhausted ||
    market?.quality !== 'verified' ||
    !Number.isFinite(market.updatedAt) ||
    Date.now() < market.updatedAt ||
    Date.now() - market.updatedAt >= 15000
  ) {
    host.store.put('showcase-proposals', { ...proposal, stage: 'evidence' });
    return;
  }
  if (proposal.decision.action === 'buy') {
    // An expired report needs an actual refresh, not a rejection or a renewed
    // timestamp. The fresh result still blocks known risks and missing proof.
    const report = await host.risk.refresh(token);
    if (host.io.exhausted || !currentRiskEvidence(report)) {
      host.store.put('showcase-proposals', { ...proposal, stage: 'risk' });
      return;
    }
    if (!report.buyAllowed) {
      app.showcase.rejectProposal(proposal, '当前风险核查未通过，未提交模拟订单。');
      return;
    }
  }
  // Reserve room for exact buy/sell and reverse quotes on converted routes.
  // A budget continuation keeps the same durable, expiring intent and key.
  if (host.io.remaining < 48) {
    host.store.put('showcase-proposals', { ...proposal, stage: 'execute' });
    return;
  }
  await host.market.updateHead();
  await host.market.fx();
  if (!host.io.exhausted && app.showcase.validateProposal(proposal)) {
    host.store.put('showcase-proposals', { ...proposal, stage: 'execute' });
    await app.showcase.executeProposal(proposal);
  }
}

// A validated model response is persisted without placing an order. These are
// new alarm invocations, each with its own capped budget, not resumed model I/O.
export async function runProposalRound(host, app, proposal) {
  if (!app.showcase.validateProposal(proposal)) return;
  await host.market.updateHead();
  await host.market.fx();
  if (host.marketPolicy?.selfHosted) {
    await submitDirect(host, app, proposal);
    host.store.put('cloud-settings', {
      id: 'scheduler',
      at: Date.now(),
      ok: !host.io.exhausted,
      phase: 'proposal-direct',
    });
    return;
  }
  if (proposal.stage === 'evidence') {
    await host.market.refresh([proposal.decision.token], { limit: 1, onlyRequested: true });
    const market = host.market.getMarket?.('bsc', proposal.decision.token);
    if (
      !host.io.exhausted &&
      market?.quality === 'verified' &&
      Date.now() - market.updatedAt >= 0 &&
      Date.now() - market.updatedAt < 15000
    ) {
      host.store.put('showcase-proposals', { ...proposal, stage: 'risk' });
    }
  } else if (proposal.stage === 'risk' && proposal.decision.action === 'buy') {
    const report = await host.risk.refresh(proposal.decision.token);
    if (!host.io.exhausted) {
      if (report.buyAllowed)
        host.store.put('showcase-proposals', { ...proposal, stage: 'execute' });
      else app.showcase.rejectProposal(proposal, 'AI 提案未通过当前风险核查，未提交订单。');
    }
  } else {
    // Evidence/risks collected in the previous stages retain their original age.
    // PaperDesk still validates them and both live quotes before any order exists.
    const metadata = host.market.metadata?.get(proposal.decision.token);
    if (metadata && (Date.now() - metadata.at < 0 || Date.now() - metadata.at >= 90000))
      host.store.put('showcase-proposals', { ...proposal, stage: 'evidence' });
    else if (
      proposal.decision.action === 'buy' &&
      !host.risk.snapshot(proposal.decision.token).buyAllowed
    )
      app.showcase.rejectProposal(proposal, '执行前风险资料已过期或条件变化，未提交订单。');
    else await app.showcase.executeProposal(proposal);
  }
  host.store.put('cloud-settings', {
    id: 'scheduler',
    at: Date.now(),
    ok: !host.io.exhausted,
    phase: 'proposal-' + proposal.stage,
    ...(host.io.exhausted ? { reason: '本轮模拟执行核查预算已用完，将在后续轮次继续。' } : {}),
  });
}
