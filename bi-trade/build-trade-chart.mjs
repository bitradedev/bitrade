import { build } from 'esbuild';
import { copyFileSync, writeFileSync } from 'node:fs';
await build({
  entryPoints: ['bi-trade/web-src/trade-chart.js'],
  outfile: 'bi-trade/web/trade-chart.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  nodePaths: ['paper-terminal/node_modules'],
  legalComments: 'eof',
});
copyFileSync(
  'paper-terminal/node_modules/lightweight-charts/LICENSE',
  'bi-trade/web/chart-LICENSE.txt',
);
writeFileSync(
  'bi-trade/web/chart-NOTICE.txt',
  'TradingView Lightweight Charts™\nCopyright (с) 2025 TradingView, Inc. https://www.tradingview.com/\n\nDistribution: v5.2.1, Copyright (c) 2026 TradingView, Inc.\nLicensed under Apache License 2.0. See chart-LICENSE.txt.\n',
);
