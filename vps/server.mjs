import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import worker, { TradingPlatform } from './dist/worker.mjs';
import { SqliteStorage } from './sqlite-storage.mjs';

process.umask(0o077);
const origin = process.env.SITE_ORIGIN ?? 'http://127.0.0.1:8797';
const port = Number(process.env.BI_TRADE_PORT ?? 8797);
const host = process.env.BI_TRADE_LISTEN_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(host)) throw Error('Service must bind to loopback');
const assetRoot = resolve(process.env.BI_TRADE_ASSET_DIR ?? './web');
const runScheduler = process.env.BI_TRADE_RUN_SCHEDULER === 'true';
if (!process.env.BI_TRADE_VAULT_KEY) throw Error('Persistent BI_TRADE_VAULT_KEY is required');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const suffix = (path) => path.slice(path.lastIndexOf('.')).toLowerCase();
const assets = {
  async fetch(request) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad path', { status: 400 });
    }
    const target = resolve(assetRoot, '.' + pathname);
    if (target !== assetRoot && !target.startsWith(assetRoot + sep))
      return new Response('Bad path', { status: 400 });
    try {
      return new Response(await readFile(target), {
        headers: { 'Content-Type': mime[suffix(target)] ?? 'application/octet-stream' },
      });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR')
        return new Response('Not found', { status: 404 });
      throw error;
    }
  },
};

let timer;
let platform;
let activeAlarm = null;
let stopping = false;
const storage = new SqliteStorage(process.env.BI_TRADE_DB_PATH ?? './data/bitrade.sqlite', () => {
  if (platform && runScheduler && !stopping) void scheduleAlarm();
});
const env = {
  ...process.env,
  SITE_ORIGIN: origin,
  BI_TRADE_SELF_HOSTED: 'true',
  BI_TRADE_VAULT_KEY: process.env.BI_TRADE_VAULT_KEY,
  ASSETS: assets,
  PLATFORM: { idFromName: () => 'local', get: () => platform },
};
platform = new TradingPlatform({ storage, blockConcurrencyWhile: (fn) => fn() }, env);

async function scheduleAlarm() {
  clearTimeout(timer);
  if (stopping) return;
  const at = await storage.getAlarm();
  if (at === null) return;
  timer = setTimeout(
    async () => {
      try {
        activeAlarm = platform.alarm();
        await activeAlarm;
      } catch (error) {
        console.error('Background round failed:', error?.name ?? 'UnknownError');
      } finally {
        activeAlarm = null;
        if (!stopping) void scheduleAlarm();
      }
    },
    Math.max(10, Math.min(2147483647, at - Date.now())),
  );
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 5_100_000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers(req.headers);
    const proxyIp = req.headers['x-real-ip'];
    headers.set(
      'CF-Connecting-IP',
      typeof proxyIp === 'string' && isIP(proxyIp)
        ? proxyIp
        : (req.socket.remoteAddress ?? 'local'),
    );
    const input = new Request(new URL(req.url, origin), {
      method: req.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const output = await worker.fetch(input, env);
    for (const [key, value] of output.headers) if (key !== 'set-cookie') res.setHeader(key, value);
    const cookies = output.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.writeHead(output.status);
    if (req.method === 'HEAD' || !output.body) res.end();
    else Readable.fromWeb(output.body).pipe(res);
  } catch (error) {
    console.error('HTTP request failed:', error?.name ?? 'UnknownError');
    if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '服务暂时不可用，请稍后重试' }));
  }
});
server.requestTimeout = 120_000;
server.listen(port, host, async () => {
  console.log(`BI Trade paper service listening on ${host}:${port}`);
  if (runScheduler) {
    await platform.arm();
    await scheduleAlarm();
  }
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  const closed = new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all([closed, activeAlarm]);
  await platform.app?.close();
  await Promise.all([platform.working, platform.decisionTask]);
  storage.close();
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () =>
    shutdown().catch((error) => {
      console.error('Shutdown failed:', error?.name ?? 'UnknownError');
      process.exitCode = 1;
    }),
  );
}
