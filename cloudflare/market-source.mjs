import { publicEndpoint } from './rpc.mjs';

// Optional user-owned read-only relay. It never receives the GMGN key from the Worker.
export function marketFetch(env, fetchImpl = (...args) => fetch(...args)) {
  if (!env.GMGN_RELAY_URL && !env.GMGN_RELAY_TOKEN) return fetchImpl;
  if (!env.GMGN_RELAY_URL || !env.GMGN_RELAY_TOKEN) throw Error('行情中继配置不完整');
  const endpoint = new URL(publicEndpoint(env.GMGN_RELAY_URL));
  if (endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
    throw Error('行情中继必须使用 HTTPS 根地址');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(env.GMGN_RELAY_TOKEN)) throw Error('行情中继授权格式不正确');
  return (input, options = {}) => {
    const upstream = new URL(input);
    const routes = new Map([
      ['/v1/token/info', 'GET'],
      ['/v1/token/security', 'GET'],
      ['/v1/market/token_top_holders', 'GET'],
      ['/v1/trenches', 'POST'],
    ]);
    if (
      upstream.origin !== 'https://openapi.gmgn.ai' ||
      upstream.username ||
      upstream.password ||
      upstream.hash ||
      routes.get(upstream.pathname) !== options.method
    )
      throw Error('不支持的行情来源');
    const relay = new URL(upstream.pathname + upstream.search, endpoint.origin);
    return fetchImpl(relay, {
      method: options.method,
      body: options.body,
      signal: options.signal,
      redirect: 'manual',
      headers: {
        Authorization: 'Bearer ' + env.GMGN_RELAY_TOKEN,
        'Content-Type': 'application/json',
      },
    });
  };
}
