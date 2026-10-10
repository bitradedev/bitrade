import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Align request timestamps with the API without changing the Windows clock.
const require = createRequire(realpathSync(fileURLToPath(new URL('../node_modules/gmgn-cli/package.json', import.meta.url))));
const { ProxyAgent, Agent } = require('undici');
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const dispatcher = proxy ? new ProxyAgent(proxy) : new Agent({connect:{family:4}});
const originalNow = Date.now.bind(Date);
const started = performance.now();
let serverTime;
try {
  const response = await fetch('https://openapi.gmgn.ai/', {
    method: 'HEAD', dispatcher, signal: AbortSignal.timeout(12000),
  });
  serverTime = Date.parse(response.headers.get('date') || '');
  if (!Number.isFinite(serverTime)) throw new Error('API response omitted its server time.');
} finally {
  await dispatcher.close();
}
const offset = serverTime + (performance.now() - started) / 2 - originalNow();
Date.now = () => originalNow() + offset;
console.error(`[wallet-analysis] API request clock aligned (${Math.round(offset / 1000)} seconds).`);
console.error(`[wallet-analysis-clock] ${JSON.stringify({serverDateHeader: new Date(serverTime).toISOString(), alignedRequestTime: new Date(Date.now()).toISOString()})}`);
