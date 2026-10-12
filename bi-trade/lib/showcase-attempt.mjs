function failure(message) {
  // The stored provider error remains private. Publish only bounded categories.
  if (/CF_SUBREQUEST_BUDGET|请求预算/.test(message))
    return { code: 'REQUEST_BUDGET', reason: '请求预算不足，本次未完成模拟下单。' };
  if (/过期|expired|stale/i.test(message))
    return { code: 'EXPIRED_EVIDENCE', reason: '报价或核查资料已过期，本次未完成模拟下单。' };
  if (/429|RATE_LIMIT|限频|冷却/i.test(message))
    return { code: 'SOURCE_LIMITED', reason: '行情来源暂时限频，本次未完成模拟下单。' };
  if (/余额|balance/i.test(message))
    return { code: 'BALANCE', reason: '虚拟余额不足以支付本次交易与费用。' };
  if (/风险|持仓|捆绑|集中|税|貔貅|身份|滑点|风险核查/.test(message))
    return { code: 'CHECK_REJECTED', reason: '当前风险或执行条件未通过，未完成模拟下单。' };
  return { code: 'EXECUTION_UNAVAILABLE', reason: '本次模拟下单未完成，等待重新评估。' };
}
export function showcaseAttempt(store, agent) {
  if (agent.source !== 'builtin') return null;
  const request = store.forAgent('requests', agent.id).sort((a, b) => b.createdAt - a.createdAt)[0],
    proposal = store.get('showcase-proposals', agent.id);
  if (proposal && (!request || proposal.createdAt > request.createdAt)) {
    const pending = proposal.state === 'pending';
    return {
      at: proposal.completedAt ?? proposal.createdAt,
      status: pending ? 'pending' : proposal.state,
      stage: proposal.stage,
      side: proposal.decision.action,
      ...(!pending && proposal.state !== 'submitted'
        ? failure(proposal.reason ?? '')
        : {
            code: null,
            reason: 'AI 已提出交易，正在核对当前行情与风险。',
          }),
    };
  }
  if (!request) return null;
  const order = store.get('paper-orders', request.id) ?? request;
  return {
    at: order.createdAt ?? request.createdAt,
    status: order.status,
    stage: 'order',
    side: request.action === 'buy_token' ? 'buy' : 'sell',
    ...(order.status === 'failed' || order.status === 'cancelled'
      ? failure(order.error ?? '')
      : { code: null, reason: '模拟订单结果以成交记录为准。' }),
  };
}
