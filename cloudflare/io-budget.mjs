import { AsyncLocalStorage } from 'node:async_hooks';
export class IOBudget {
  constructor(limit = 45, fetchImpl = (...args) => fetch(...args)) {
    this.limit = limit;
    this.context = new AsyncLocalStorage();
    this.lastAlarm = null;
    this.fetch = (...args) => {
      const round = this.context.getStore();
      if (round) {
        if (round.used >= this.limit)
          throw Object.assign(Error('CF_SUBREQUEST_BUDGET: subrequest limit'), {
            code: 'CF_SUBREQUEST_BUDGET',
          });
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
        if (kind === 'alarm') this.lastAlarm = { ...round, at: Date.now() };
      }
    });
  }
}
