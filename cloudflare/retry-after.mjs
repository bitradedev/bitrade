export { retryAfter } from '../bi-trade/lib/http-retry.mjs';

// One affected production row from the old parser. Do not heuristically shorten
// other legacy deadlines or any explicit HTTP-date parsed by the new code.
// The original header was not retained: use 2039 seconds (longer than 39), and
// at least five more minutes after correction. Preserve the complete old row.
export function correctKnownLegacyCooldown(store, now) {
  const old = store.get('cloud-settings', 'public-budget-dex');
  if (
    !old ||
    old.retryAfterVersion ||
    old.lastError !== 'HTTP 429' ||
    old.lastAt !== 1791669862535 ||
    old.retryAt !== 2177452805000
  )
    return;
  const correctedRetryAt = Math.max(old.lastAt + 2039 * 1000 + 5000, now + 300000);
  store.put('cloud-settings', {
    id: 'public-retry-correction-20261011',
    at: now,
    previous: old,
    correctedRetryAt,
    delayUpperBoundSeconds: 2039,
    basis: 'legacy-numeric-date-parser-signature',
    headerKnown: false,
  });
  store.put('cloud-settings', {
    ...old,
    retryAt: correctedRetryAt,
    retryAfterVersion: 2,
    retryAfterKind: 'legacy-corrected',
    cooldownCorrectionId: 'public-retry-correction-20261011',
  });
}
