import { CloudStore } from '../cloudflare/store.mjs';

// The VPS database has no Cloudflare per-day SQL write allowance. Keep the
// original ledger, authentication and risk behavior, without the free-tier
// pause/checkpoint that was specific to Durable Objects.
export class SelfHostedStore extends CloudStore {
  constructor(storage, options) {
    super(storage, options);
    this.budget.limit = Number.MAX_SAFE_INTEGER;
  }

  prepareWriteBudget() {}
}
