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
