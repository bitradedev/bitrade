import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

const requireTool = createRequire(realpathSync('node_modules/wrangler/package.json'));
const { build } = requireTool('esbuild');

await build({
  entryPoints: ['cloudflare/worker.ts'],
  outfile: 'vps/dist/worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  alias: { 'cloudflare:workers': './vps/workers-shim.mjs' },
});
await build({
  entryPoints: ['vps/candles.mjs'],
  outfile: 'vps/dist/candles.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
