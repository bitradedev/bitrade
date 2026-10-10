import { createServer } from 'node:http';
import { request as requestHTTPS } from 'node:https';
import { Readable } from 'node:stream';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const ROUTES = new Map([
  ['/v1/token/info', 'GET'],
  ['/v1/token/security', 'GET'],
  ['/v1/market/token_top_holders', 'GET'],
  ['/v1/trenches', 'POST'],
]);
const ADDRESS = /^0x[a-f0-9]{40}$/i;
function ipv4Fetch(url, options) {
  return new Promise((resolve, reject) => {
    const req = requestHTTPS(
      url,
      {
        method: options.method,
        headers: { ...options.headers, 'Accept-Encoding': 'identity' },
        signal: options.signal,
        family: 4,
      },
      (res) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
const reply = (res, status, value, extra = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(JSON.stringify(value));
};
const equal = (a, b) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createRelay({ apiKey, relayToken, fetchImpl = ipv4Fetch, now = Date.now } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey))
    throw Error('GMGN key required');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(relayToken ?? '')) throw Error('Relay token required');
  let lastAt = -Infinity,
    cooldown = 0;
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health')
        return reply(res, 200, { service: 'gmgn-read-relay', readOnly: true });
      if (!equal(req.headers.authorization ?? '', 'Bearer ' + relayToken))
        return reply(res, 401, { error: 'Unauthorized' });
      const url = new URL(req.url, 'https://relay.invalid'),
        method = ROUTES.get(url.pathname);
      if (!method || method !== req.method)
        return reply(res, 404, { error: 'Read-only route not found' });
      const allowed = new Set([
        'chain',
        'timestamp',
        'client_id',
        ...(method === 'GET' ? ['address', 'limit', 'order_by', 'direction'] : []),
      ]);
      if (
        [...url.searchParams.keys()].some(
          (k) => !allowed.has(k) || url.searchParams.getAll(k).length !== 1,
        ) ||
        url.searchParams.get('chain') !== 'bsc' ||
        (method === 'GET' && !ADDRESS.test(url.searchParams.get('address') ?? ''))
      )
        return reply(res, 400, { error: 'Invalid BSC market query' });
      if (
        url.pathname === '/v1/market/token_top_holders' &&
        (!/^\d+$/.test(url.searchParams.get('limit') ?? '100') ||
          Number(url.searchParams.get('limit') ?? 100) > 100 ||
          Number(url.searchParams.get('limit') ?? 100) < 1 ||
          !['amount_percentage', null].includes(url.searchParams.get('order_by')) ||
          !['asc', 'desc', null].includes(url.searchParams.get('direction')))
      )
        return reply(res, 400, { error: 'Invalid holder query' });
      let bytes = 0,
        body = '';
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) {
          reply(res, 413, { error: 'Body too large' });
          req.destroy();
          return;
        }
        body += chunk;
      }
      if (method === 'POST') {
        const data = JSON.parse(body);
        if (
          data.version !== 'v2' ||
          Object.keys(data).some(
            (k) => !['version', 'new_creation', 'near_completion', 'completed'].includes(k),
          )
        )
          return reply(res, 400, { error: 'Invalid discovery request' });
        for (const k of ['new_creation', 'near_completion', 'completed']) {
          const section = data[k];
          if (
            !section ||
            Object.keys(section).some(
              (k) =>
                !['filters', 'launchpad_platform_v2', 'limit', 'quote_address_type'].includes(k),
            ) ||
            !Number.isInteger(section.limit) ||
            section.limit < 1 ||
            section.limit > 8 ||
            section.launchpad_platform_v2 !== true ||
            !Array.isArray(section.filters) ||
            section.filters.length > 2 ||
            section.filters.some((x) => !['offchain', 'onchain'].includes(x)) ||
            !Array.isArray(section.quote_address_type) ||
            section.quote_address_type.length < 1 ||
            section.quote_address_type.length > 12 ||
            section.quote_address_type.some(
              (x) => ![6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0].includes(x),
            )
          )
            return reply(res, 400, { error: 'Discovery batch exceeds relay policy' });
        }
      } else if (body) return reply(res, 400, { error: 'Unexpected request body' });
      const retryAt = Math.max(cooldown, lastAt + 3000);
      if (now() < retryAt)
        return reply(
          res,
          429,
          { code: 429, error: 'RATE_LIMIT_EXCEEDED', reset_at: Math.ceil(retryAt / 1000) },
          { 'X-RateLimit-Reset': String(Math.ceil(retryAt / 1000)) },
        );
      lastAt = now();
      // Generate auth freshness at the egress. Never forward visitor IP headers,
      // caller-supplied keys, cookies, signatures or caller-controlled hosts.
      const target = new URL(url.pathname + url.search, 'https://openapi.gmgn.ai');
      target.searchParams.set('timestamp', String(Math.floor(now() / 1000)));
      target.searchParams.set('client_id', randomUUID());
      const upstream = await fetchImpl(target, {
        method,
        body: method === 'POST' ? body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          'X-APIKEY': apiKey,
          'Content-Type': 'application/json',
          'User-Agent': 'bitrade-market-relay/1',
        },
      });
      if (upstream.status >= 300 && upstream.status < 400)
        return reply(res, 502, { error: 'Upstream redirect refused' });
      const reader = upstream.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw Error('Oversized market response');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (JSON.stringify(value).includes(apiKey) || JSON.stringify(value).includes(relayToken))
        return reply(res, 502, { error: 'Unsafe upstream response refused' });
      const reset = Number(value?.reset_at ?? upstream.headers.get('X-RateLimit-Reset')),
        retry = Number(upstream.headers.get('Retry-After'));
      if (upstream.status === 429 || Number(value?.code) === 429)
        cooldown = Math.max(
          now() + 65000,
          Number.isFinite(reset) && reset * 1000 > now() && reset * 1000 < now() + 31 * 86400000
            ? reset * 1000 + 5000
            : 0,
          Number.isFinite(retry) && retry > 0 && retry < 31 * 86400
            ? now() + retry * 1000 + 5000
            : 0,
        );
      const headers = {};
      for (const name of ['X-RateLimit-Reset', 'Retry-After']) {
        const text = upstream.headers.get(name);
        if (text) headers[name] = text;
      }
      reply(res, upstream.status, value, headers);
    } catch {
      if (!res.headersSent) reply(res, 502, { error: 'Market upstream unavailable' });
      else res.end();
    }
  });
}

if (import.meta.main) {
  const relay = createRelay({
    apiKey: process.env.GMGN_API_KEY,
    relayToken: process.env.GMGN_RELAY_TOKEN,
  });
  relay.listen(Number(process.env.PORT ?? 8788), '0.0.0.0', () =>
    console.log('Read-only BSC market relay ready'),
  );
}
