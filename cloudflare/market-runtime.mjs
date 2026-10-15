// Local orchestration bounds. Provider cooldowns and evidence ages are separate.
const cloud = Object.freeze({
  selfHosted: false,
  requestsPerRound: 45,
  rpcConcurrency: 1,
  refreshBatch: 1,
  refreshConcurrency: 1,
  discoveryIntervalMs: 60000,
  flapIntervalMs: 120000,
});
const server = Object.freeze({
  selfHosted: true,
  requestsPerRound: 128,
  rpcConcurrency: 4,
  refreshBatch: 6,
  refreshConcurrency: 4,
  discoveryIntervalMs: 30000,
  flapIntervalMs: 30000,
});
export const marketRuntime = (env = {}) => (env.BI_TRADE_SELF_HOSTED === 'true' ? server : cloud);
