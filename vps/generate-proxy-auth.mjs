import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.umask(0o077);
const directory = resolve(process.argv[2] ?? '.cloud-test-build/vps-access');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const secret = randomBytes(32).toString('hex');
writeFileSync(resolve(directory, 'proxy-token.txt'), secret + '\n', { mode: 0o600 });
writeFileSync(
  resolve(directory, 'proxy-auth.conf'),
  `if ($http_x_bi_proxy_key != "${secret}") { return 403; }\n`,
  { mode: 0o600 },
);
console.log('Proxy authentication material generated in the private output directory.');
