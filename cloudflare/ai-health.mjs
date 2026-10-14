// Only bounded categories and timings are retained. No prompts, credentials,
// provider response bodies, endpoint URLs, or arbitrary error messages enter it.
export function recordAIHealth(store, observation) {
  const day = new Date(observation.at).toISOString().slice(0, 10);
  const old = store.get('cloud-settings', 'ai-service-health');
  const current = old?.day === day ? old : { day, successes: 0, failures: 0, recent: [] };
  const sample = {
    at: observation.at,
    durationMs: observation.durationMs,
    contextBytes: observation.contextBytes,
    ok: observation.ok === true,
    code: observation.code,
    networkCode: observation.networkCode,
    httpStatus: observation.httpStatus,
  };
  store.put('cloud-settings', {
    id: 'ai-service-health',
    day,
    successes: current.successes + Number(sample.ok),
    failures: current.failures + Number(!sample.ok),
    recent: [...current.recent, sample].slice(-16),
  });
}
