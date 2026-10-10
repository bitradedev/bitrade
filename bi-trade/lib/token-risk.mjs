import { GmgnReadQueue } from '../../paper-terminal/dist/server/adapters/gmgn.js';
import { TokenRiskGuard as Core } from './token-risk-core.mjs';
export { evaluateTokenRisk, RISK_POLICY } from './token-risk-core.mjs';
export class TokenRiskGuard extends Core {
  constructor(store, options = {}) {
    super(store, {
      ...options,
      source: options.source ?? new GmgnReadQueue(options.proxy ?? process.env.PAPER_PROXY),
    });
  }
}
