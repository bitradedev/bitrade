import { AsyncLocalStorage } from 'node:async_hooks';
export class IOBudget {
  constructor(limit = 45, fetchImpl = (...args) => fetch(...args)) {
    this.limit = limit;
    this.context = new AsyncLocalStorage();
    this.lastAlarm = null;
    this.decision = null;
    this.fetch = (...args) => {
      const round = this.context.getStore();
      if (round) {
        if (round.used >= this.limit) {
          round.exhausted = true;
          throw Object.assign(Error('CF_SUBREQUEST_BUDGET: subrequest limit'), {
            code: 'CF_SUBREQUEST_BUDGET',
          });
        }
        round.used++;
      }
      return fetchImpl(...args);
    };
  }
  run(kind, task) {
    const round = { used: 0, limit: this.limit };
    return this.context.run(round, async () => {
      try {
        return await task();
      } finally {
        if (kind === 'alarm') this.lastAlarm = Object.assign(round, { at: Date.now() });
      }
    });
  }
  get remaining() {
    return Math.max(0, this.limit - (this.context.getStore()?.used ?? 0));
  }
  get exhausted() {
    return this.context.getStore()?.exhausted === true;
  }
  trackDecision(task) {
    const round = this.context.getStore();
    if (!round) throw Error('Decision work requires an invocation budget');
    const record = { round, startedAt: Date.now(), completedAt: null };
    this.decision = record;
    return Promise.resolve(task).finally(() => {
      record.completedAt = Date.now();
    });
  }
  get lastDecision() {
    const d = this.decision;
    return d
      ? {
          used: d.round.used,
          limit: d.round.limit,
          startedAt: d.startedAt,
          completedAt: d.completedAt,
        }
      : null;
  }
}
