export const TRADING_NETWORKS = Object.freeze({
  bsc: Object.freeze({
    chain: 'bsc',
    name: 'BNB Chain',
    chainId: 56,
    native: 'BNB',
    explorer: 'https://bscscan.com',
  }),
  robinhood: Object.freeze({
    chain: 'robinhood',
    name: 'Robinhood Chain',
    chainId: 4663,
    native: 'ETH',
    explorer: 'https://robinhoodchain.blockscout.com',
  }),
});

export function tradingNetwork(chain = 'bsc') {
  const network = TRADING_NETWORKS[chain];
  if (!network) throw Error('Unsupported trading network');
  return network;
}

// Authentication, wallets and Agent identities stay shared. Every trading,
// risk and market entity lives in its own chain partition. Existing BSC keys
// are deliberately unchanged; no historical native amount is converted.
const SHARED = new Set(['agents', 'owners', 'pairings', 'ai-config', 'settings']);
export function chainStore(base, chain) {
  tradingNetwork(chain);
  if (chain === 'bsc') return base;
  const kindFor = (kind) => (SHARED.has(kind) ? kind : `${chain}:${kind}`);
  const db = {
    exec: (...args) => base.db.exec(...args),
    prepare(sql) {
      const statement = base.db.prepare(sql);
      const map = (args) =>
        /\bintents\b/i.test(sql)
          ? [args[0], `${chain}:${args[1]}`, ...args.slice(2)]
          : /\bentities\b/i.test(sql) && /kind\s*=\s*\?|entities\s+VALUES\s*\(/i.test(sql)
            ? [kindFor(args[0]), ...args.slice(1)]
            : args;
      return Object.fromEntries(
        ['get', 'all', 'run'].map((method) => [
          method,
          (...args) => statement[method](...map(args)),
        ]),
      );
    },
  };
  return new Proxy(base, {
    get(target, key) {
      if (key === 'db') return db;
      if (['get', 'all', 'put', 'forAgent', 'byOwner'].includes(key))
        return (kind, ...args) => target[key](kindFor(kind), ...args);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
