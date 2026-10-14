import { build } from 'esbuild';

await build({
  entryPoints: ['cloudflare/worker.ts'],
  outfile: 'vps/dist/worker.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  alias: { 'cloudflare:workers': './vps/workers-shim.mjs' },
});
