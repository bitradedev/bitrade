import { isIP } from 'node:net';
export function normalizeIP(value) {
  if (typeof value !== 'string') return null;
  const ip = value
    .trim()
    .toLowerCase()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  return isIP(ip) ? ip : null;
}
export function trustedProxyList(value = []) {
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values)) throw Error('Trusted proxy addresses must be a list');
  return new Set(
    values
      .filter((v) => String(v).trim())
      .map((v) => {
        const ip = normalizeIP(v);
        if (!ip) throw Error('Trusted proxy address is invalid');
        return ip;
      }),
  );
}
export function clientAddress(req, trusted = new Set()) {
  const peer = normalizeIP(req.socket.remoteAddress) ?? 'unknown';
  if (!trusted.has(peer)) return peer;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header.length > 2048) return peer;
  const hops = header.split(',').map(normalizeIP);
  if (!hops.length || hops.some((ip) => !ip)) return peer;
  let address = peer;
  for (let i = hops.length - 1; i >= 0 && trusted.has(address); i--) address = hops[i];
  return address;
}
