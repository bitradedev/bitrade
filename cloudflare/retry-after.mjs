// RFC 9110 section 10.2.3: delay-seconds and HTTP-date are distinct forms.
// Date.parse('39') accepts a year in JavaScript; it is never a date header.
const HTTP_DATE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/;

export function retryAfter(value, now) {
  if (value === null || value === undefined) return { kind: 'missing', at: null };
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw),
      at = now + seconds * 1000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(at) && at <= 8640000000000000
      ? { kind: 'seconds', at }
      : { kind: 'invalid', at: null };
  }
  // The obsolete asctime form also denotes GMT, not the host's local zone.
  const at = HTTP_DATE.test(raw) ? Date.parse(raw.endsWith(' GMT') ? raw : raw + ' GMT') : NaN;
  return Number.isFinite(at) ? { kind: 'date', at } : { kind: 'invalid', at: null };
}

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
