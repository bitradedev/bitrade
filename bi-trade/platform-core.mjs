import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  digest,
  identifier,
  fail,
  fields,
  raw,
  json,
  canonicalJson,
} from './lib/database-core.mjs';
import { OwnerAuth, address, COOKIE } from './lib/auth.mjs';

import { PaperDesk } from './lib/paper-desk.mjs';
import { LiveDesk, swapIntent, executionError } from './lib/live-desk.mjs';
import { BscRpc, v2Abi, ROUTER_V2 } from './lib/bsc-rpc.mjs';
import { viem } from './lib/dependencies.mjs';

import { publicAgent, leaderboard } from './lib/public-agents.mjs';
import { ShowcaseAgents } from './lib/showcase-agents-core.mjs';
import { avatarFor, validateAvatar } from './lib/agent-avatars.mjs';

const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const toolsList = [
  {
    name: 'register_dot',
    description: 'Consume a one-use pairing link. Persist the returned agentToken securely.',
    inputSchema: {
      type: 'object',
      properties: { pairingCode: { type: 'string' }, name: { type: 'string' } },
      required: ['pairingCode', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_account',
    description: 'Read this Agent’s permanent BSC wallet, mode, pause state and balances.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'buy_token',
    description:
      'Buy using native BNB wei within available balance including fees. Each paper Agent starts with 1000 USD, without a fixed single-order cap. Live is disabled by default.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        amount: { type: 'string' },
        requestKey: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['token', 'amount', 'requestKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_transaction',
    description:
      'Submit BSC calldata in live balance mode. In paper mode, only decoded V2/V3 buy or sell intents are simulated; arbitrary calls are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        data: { type: 'string' },
        value: { type: 'string' },
        requestKey: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['to', 'requestKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_trade',
    description:
      'Read/reconcile one transaction belonging to this Agent. Never assume a pending request was filled.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function originUrl(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    (u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
  )
    throw Error('站点地址必须使用HTTPS（本机预览除外）');
  return u.origin;
}
export async function createPlatformCore(options) {
  let origin = originUrl(options.origin ?? 'http://127.0.0.1:8794');
  const store = options.store,
    auth = new OwnerAuth(store, origin);
  const vault = options.vault;
  for (const a of store.all('agents')) {
    try {
      if (vault.account(a).address.toLowerCase() !== a.address) throw Error();
    } catch {
      store.close();
      throw Error('钱包加密密钥与现有账本不匹配，请恢复原密钥');
    }
  }
  let paper;
  const gap = (c) => {
    if (!c || c === 'bsc') paper?.gap();
  };
  const gateway = options.gateway;
  const riskGuard = options.showcase === false ? null : options.riskGuard;
  paper = new PaperDesk(store, gateway, {
    preserveQueued: options.preserveQueued === true,
    buyGuard: async (a, token, q) => {
      if (a.source === 'builtin' && riskGuard)
        await riskGuard.assertBuy(token, {
          sizeUsd: q.nativeUsd ? (Number(BigInt(q.inputRaw)) / 1e18) * q.nativeUsd : null,
          marketPrice: q.marketPrice,
          refresh: q.refresh,
        });
    },
  });
  const rpc = options.rpc ?? new BscRpc(options.rpcUrl ?? process.env.BI_TRADE_BSC_RPC);
  const live = new LiveDesk(store, vault, rpc, {
    enabled: options.liveEnabled === true,
    confirmations: 3,
  });
  for (const r of store
    .all('requests')
    .filter(
      (r) =>
        r.status === 'preparing' &&
        !store.get('paper-orders', r.id) &&
        !store.get('live-orders', r.id),
    ))
    store.put('requests', {
      ...r,
      status: 'failed',
      error: '服务在准备阶段重启，没有假定订单成交',
    });
  let closing = false,
    timer,
    sourceTask;
  const quotas = new Map(),
    recoverLocks = new Set();
  function limit(req, kind, max, ms = 60000) {
    let scope = 'ip:' + (req.clientAddress ?? req.socket.remoteAddress);
    if (['requests', 'agent'].includes(kind)) {
      const session = auth.session(req);
      if (session) scope = 'owner:' + session.owner.id;
      else {
        const token = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
        if (token) {
          const c = store.db
            .prepare('SELECT agent FROM credentials WHERE hash=? AND kind=? AND expires>?')
            .get(digest(token), 'agent', Date.now());
          if (c?.agent) scope = 'agent:' + c.agent;
        }
      }
    }
    if (options.rateLimit) return options.rateLimit(req, kind, max, ms, scope);
    const key = kind + ':' + scope,
      now = Date.now(),
      q = quotas.get(key),
      item = !q || now - q.at >= ms ? { at: now, n: 0 } : q;
    item.n++;
    quotas.set(key, item);
    if (quotas.size > 10000)
      for (const [k, v] of quotas) if (now - v.at > 3600000) quotas.delete(k);
    if (item.n > max) throw fail('请求过于频繁，请稍后重试', 429);
  }
  function own(session, id, includeClosed = false) {
    const a = store.get('agents', id);
    if (!a || a.ownerId !== session.owner.id) throw fail('Agent不存在或不属于此账户', 404);
    if (a.closedAt && !includeClosed) throw fail('账户已关闭，请先恢复并重连Agent', 409);
    return a;
  }
  function visibleOrder(o) {
    if (!o) return null;
    const { signed, reference, quote, ...v } = o;
    return {
      ...v,
      quote: quote
        ? { id: quote.id, quality: quote.quality, block: quote.block, fees: quote.fees }
        : undefined,
    };
  }
  function agentDto(a) {
    const { encryptedKey, ...rest } = a,
      credential = store.db
        .prepare('SELECT 1 FROM credentials WHERE kind=? AND agent=? AND expires>?')
        .get('agent', a.id, Date.now());
    const connectionState = a.closedAt
      ? 'closed'
      : a.source === 'builtin'
        ? 'builtin'
        : !credential
          ? 'needs-reconnect'
          : !a.lastAgentRequestAt || a.lastAgentRequestAt < (a.pairedAt ?? 0)
            ? 'awaiting-agent'
            : Date.now() - a.lastAgentRequestAt < 300000
              ? 'connected'
              : 'idle';
    return {
      ...rest,
      avatar: avatarFor(a),
      connectionState,
      paper: paper.view(a.id),
      live: live.view(a),
      explorer: 'https://bscscan.com/address/' + a.address,
    };
  }
  function state(session) {
    const agents = session ? store.byOwner('agents', session.owner.id) : [],
      orders = agents.flatMap((a) => [...paper.orders(a.id), ...live.orders(a.id)]),
      seen = new Set(orders.map((o) => o.id));
    orders.push(
      ...agents.flatMap((a) => store.forAgent('requests', a.id)).filter((o) => !seen.has(o.id)),
    );
    return {
      app: 'bi-trade',
      version: 2,
      network: { name: 'BNB Chain', chainId: 56, native: 'BNB' },
      liveEnabled: live.enabled,
      csrf: session?.csrf ?? null,
      owner: session
        ? { id: session.owner.id, address: session.owner.address, kind: session.owner.kind }
        : null,
      agents: agents.filter((a) => !a.closedAt).map(agentDto),
      archivedAgents: agents.filter((a) => a.closedAt).map(agentDto),
      orders: orders
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map(visibleOrder),
      activity: agents
        .flatMap((a) => [...paper.fills(a.id), ...store.forAgent('live-activity', a.id)])
        .sort((a, b) => b.at - a.at)
        .slice(0, 100),
      market: gateway.statuses().find((x) => x.chain === 'bsc') ?? { connected: false, head: 0 },
      capitalUsd: 1000,
      maxOrderUsd: null,
    };
  }
  function pair(session, id = null, avatar = 'trend') {
    const existing = id ? own(session, id) : null;
    validateAvatar(avatar);
    if (store.byOwner('agents', session.owner.id).filter((a) => !a.closedAt).length >= 20 && !id)
      throw fail('每个账户最多20个Agent');
    const code = randomBytes(24).toString('hex'),
      p = {
        id: digest(code),
        ownerId: session.owner.id,
        agentId: id,
        avatar: existing ? avatarFor(existing) : avatar,
        expiresAt: Date.now() + 900000,
        used: false,
      };
    store.put('pairings', p);
    return {
      pairingCode: code,
      url: origin + '/pair#' + code,
      expiresAt: p.expiresAt,
      reconnect: !!id,
    };
  }
  function register(args) {
    fields(args, ['pairingCode', 'name']);
    if (
      typeof args.pairingCode !== 'string' ||
      !/^[a-f0-9]{48}$/.test(args.pairingCode) ||
      typeof args.name !== 'string' ||
      !args.name.trim() ||
      args.name.trim().length > 40
    )
      throw fail('配对码或Agent名称无效');
    return store.transaction(() => {
      const p = store.get('pairings', digest(args.pairingCode));
      if (!p || p.used || p.expiresAt <= Date.now()) throw fail('配对链接已失效或已使用', 403);
      let a = p.agentId ? store.get('agents', p.agentId) : null;
      if (p.agentId && (!a || a.ownerId !== p.ownerId || a.closedAt))
        throw fail('重连目标无效', 403);
      if (!a) {
        if (store.byOwner('agents', p.ownerId).filter((a) => !a.closedAt).length >= 20)
          throw fail('账户Agent数量达到上限');
        const id = identifier();
        a = {
          id,
          ownerId: p.ownerId,
          name: args.name.trim(),
          avatar: p.avatar ?? 'trend',
          ...vault.create(id),
          mode: 'paper',
          paused: false,
          public: false,
          createdAt: Date.now(),
          policy: { mode: 'balance' },
        };
        paper.account(id);
      }
      a.pairedAt = Date.now();
      delete a.lastAgentRequestAt;
      delete a.lastAgentTool;
      store.put('agents', a);
      store.db.prepare('DELETE FROM credentials WHERE kind=? AND agent=?').run('agent', a.id);
      const token = randomBytes(32).toString('base64url');
      store.db
        .prepare('INSERT INTO credentials VALUES(?,?,?,?,?,NULL)')
        .run(digest(token), 'agent', a.ownerId, a.id, 253402300799000);
      p.used = true;
      store.put('pairings', p);
      store.audit(
        a.ownerId,
        a.id,
        'paired',
        p.agentId ? 'Agent重连，旧凭据已撤销' : 'Agent首次配对',
      );
      return {
        dotId: a.id,
        agentId: a.id,
        address: a.address,
        chainId: 56,
        agentToken: token,
        mode: a.mode,
        paused: a.paused,
        initialPaperUsd: 1000,
      };
    });
  }
  function trade(a, id) {
    if (typeof id !== 'string' || !id || id.length > 100) throw fail('订单ID无效');
    const o =
      store.get('paper-orders', id) ?? store.get('live-orders', id) ?? store.get('requests', id);
    if (!o || o.agentId !== a.id) throw fail('订单不存在', 404);
    return o;
  }
  async function execute(a, action, args) {
    a = store.get('agents', a.id);
    if (!a || a.closedAt) throw fail('账户已关闭，不能接收交易指令', 409);
    if (typeof args.requestKey !== 'string' || !/^[\w.:~-]{1,100}$/.test(args.requestKey))
      throw fail('每笔交易需要稳定的requestKey');
    if (args.reason !== undefined && (typeof args.reason !== 'string' || args.reason.length > 600))
      throw fail('决策说明最多600字');
    const signature = digest(canonicalJson({ action, args })),
      old = store.db
        .prepare('SELECT * FROM intents WHERE agent=? AND requestKey=?')
        .get(a.id, args.requestKey);
    if (old) {
      if (old.signature !== signature && old.signature !== digest(json({ action, args })))
        throw fail('requestKey已绑定不同参数', 409);
      return visibleOrder(trade(a, old.id));
    }
    if (a.paused) throw fail('Agent已暂停', 409);
    if (a.mode === 'live') live.guard();
    if (a.source === 'builtin' && a.mode !== 'paper')
      throw fail('内置展示Agent只支持模拟交易', 403);
    const id = identifier();
    store.transaction(() => {
      store.db
        .prepare('INSERT INTO intents VALUES(?,?,?,?)')
        .run(a.id, args.requestKey, signature, id);
      store.put('requests', {
        id,
        agentId: a.id,
        mode: a.mode,
        status: 'preparing',
        createdAt: Date.now(),
        reason: args.reason ?? '',
        action,
      });
    });
    try {
      let tx;
      if (action === 'buy_token') {
        const token = address(args.token),
          amount = raw(args.amount);
        if (a.mode === 'paper')
          return visibleOrder(
            await paper.submit(a, {
              id,
              token,
              amount: String(amount),
              side: 'buy',
              reason: args.reason,
            }),
          );
        tx = await rpc.buyTransaction(a, token, amount);
      } else {
        const to = address(args.to),
          data = args.data ?? '0x',
          value = args.value ?? '0';
        if (
          typeof data !== 'string' ||
          !/^0x([a-f0-9]{2})*$/i.test(data) ||
          data.length > 131074 ||
          typeof value !== 'string' ||
          !/^\d{1,78}$/.test(value)
        )
          throw fail('交易calldata或value无效');
        if (a.policy?.mode === 'limited') throw fail('受限策略禁止通用合约调用', 403);
        tx = { to, data, value: BigInt(value), kind: 'contract' };
        if (a.mode === 'paper') {
          const intent = swapIntent(tx, a);
          if (!intent)
            throw fail('模拟模式支持解码后的Pancake V2/V3买卖意图；其他合约调用仅供实盘');
          let amount, minOutput;
          if (to === ROUTER_V2) {
            const d = viem.decodeFunctionData({ abi: v2Abi, data });
            amount = intent.side === 'buy' ? value : String(d.args[0]);
            minOutput = String(d.args[intent.side === 'buy' ? 0 : 1]);
          } else {
            const { v3Abi } = await import('./lib/bsc-rpc.mjs');
            const d = viem.decodeFunctionData({ abi: v3Abi, data });
            const swap =
              d.functionName === 'multicall'
                ? viem.decodeFunctionData({ abi: v3Abi, data: d.args[0][0] })
                : d;
            amount = String(swap.args[0].amountIn);
            minOutput = String(swap.args[0].amountOutMinimum);
          }
          raw(amount);
          return visibleOrder(
            await paper.submit(a, {
              id,
              token: intent.token,
              side: intent.side,
              amount,
              minOutput,
              reason: args.reason,
            }),
          );
        }
      }
      return visibleOrder(await live.submit(a, id, tx));
    } catch (e) {
      const r = store.get('requests', id);
      r.status = 'failed';
      r.error = executionError(e);
      store.put('requests', r);
      throw e;
    }
  }
  function touchAgent(a, name) {
    const current = store.get('agents', a.id);
    if (!current || current.closedAt) throw fail('账户已关闭，连接已撤销', 401);
    current.lastAgentRequestAt = Date.now();
    current.lastAgentTool = name;
    return store.put('agents', current);
  }
  async function action(req, name, args = {}) {
    if (!toolsList.some((t) => t.name === name)) throw fail('未知Agent工具', 404);
    if (name === 'register_dot') {
      if (req.headers.origin || req.headers['sec-fetch-site'] || auth.session(req))
        throw fail('请在已配置的Agent中完成配对；网页不能手动创建交易账户', 403);
      return register(args);
    }
    const a = auth.agent(req);
    if (name === 'get_account') {
      fields(args, []);
      const fx = paper.fx();
      if (fx) store.transaction(() => paper.seed(a.id, fx));
      await live.balance(a);
      return { ...agentDto(touchAgent(a, name)), agentToken: undefined, liveEnabled: live.enabled };
    }
    if (name === 'get_trade') {
      fields(args, ['id']);
      const o = trade(a, args.id);
      if (o.mode === 'live' && live.enabled) await live.reconcile(o);
      touchAgent(a, name);
      return visibleOrder(trade(a, args.id));
    }
    fields(
      args,
      name === 'buy_token'
        ? ['token', 'amount', 'requestKey', 'reason']
        : ['to', 'data', 'value', 'requestKey', 'reason'],
    );
    return execute(touchAgent(a, name), name, args);
  }
  function archive(session, id) {
    return store.transaction(() => {
      const a = own(session, id, true);
      if (a.closedAt) return agentDto(a);
      if (live.orders(a.id).some((o) => ['preparing', 'signed', 'submitted'].includes(o.status)))
        throw fail('有待核对的实盘交易，暂不能关闭账户', 409);
      a.closedAt = Date.now();
      a.paused = true;
      a.public = false;
      store.put('agents', a);
      paper.pause(a.id);
      store.db.prepare('DELETE FROM credentials WHERE kind=? AND agent=?').run('agent', a.id);
      for (const p of store.all('pairings').filter((p) => p.agentId === a.id && !p.used)) {
        p.used = true;
        store.put('pairings', p);
      }
      store.audit(a.ownerId, a.id, 'closed', '账户关闭并归档；凭据撤销，历史与钱包保留');
      return agentDto(a);
    });
  }
  function restore(session, id) {
    return store.transaction(() => {
      const a = own(session, id, true);
      if (!a.closedAt) throw fail('账户未关闭', 409);
      if (store.byOwner('agents', session.owner.id).filter((x) => !x.closedAt).length >= 20)
        throw fail('每个账户最多20个Agent');
      a.closedAt = null;
      a.paused = true;
      a.public = false;
      store.put('agents', a);
      store.audit(a.ownerId, a.id, 'restored', '账户恢复，保持暂停，须重新配对');
      return agentDto(a);
    });
  }
  async function body(req) {
    let b = '';
    for await (const chunk of req) {
      b += chunk;
      if (Buffer.byteLength(b) > 160000) throw fail('请求内容过大', 413);
    }
    try {
      return JSON.parse(b);
    } catch {
      throw fail('请求须为JSON');
    }
  }
  function ownerSession(req, write = false) {
    const s = auth.session(req);
    if (!s) throw fail('请先连接账户', 401);
    if (write && !equal(req.headers['x-csrf-token'], s.csrf)) throw fail('账户请求校验失败', 403);
    return s;
  }
  function cookie(res, token) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 86400 : 0}${origin.startsWith('https:') ? '; Secure' : ''}`,
    );
  }
  function send(res, status, value, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type });
    res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : json(value));
  }
  let tokenCache = { at: 0, market: null };
  async function tokenInfo() {
    const ca = options.tokenAddress ?? process.env.BI_TRADE_TOKEN_ADDRESS;
    if (!ca) return { symbol: 'BI', address: null, issued: false, market: null };
    const token = address(ca);
    if (Date.now() - tokenCache.at > 60000) {
      tokenCache.at = Date.now();
      try {
        const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + token, {
          signal: AbortSignal.timeout(5000),
        });
        const data = await r.json();
        tokenCache.market =
          (data.pairs ?? [])
            .filter((p) => p.chainId === 'bsc' && p.baseToken?.address.toLowerCase() === token)
            .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
      } catch {
        tokenCache.market = null;
      }
    }
    return { symbol: 'BI', address: token, issued: true, market: tokenCache.market, holders: null };
  }
  function publicState(url) {
    const tracked = store.all('agents').filter((a) => a.public && !a.closedAt),
      filter = url.searchParams.get('agent'),
      mode = url.searchParams.get('mode') ?? 'all',
      page = Math.max(0, Math.min(1000, Math.floor(Number(url.searchParams.get('page')) || 0)));
    if (!['paper', 'live', 'all'].includes(mode)) throw fail('交易模式筛选无效');
    const agents = tracked.map((a) => publicAgent(store, paper, live, a));
    let allRows = tracked
        .filter((a) => !filter || a.id === filter)
        .flatMap((a) =>
          [...paper.fills(a.id), ...store.forAgent('live-activity', a.id)].map((x) => ({
            ...x,
            name: a.name,
            address: a.address,
          })),
        ),
      rows = allRows.filter((x) => mode === 'all' || x.mode === mode).sort((a, b) => b.at - a.at);
    const summary = ['paper', 'live'].map((type) => ({
      mode: type,
      realizedWei: String(
        allRows.filter((x) => x.mode === type).reduce((n, x) => n + BigInt(x.netRaw ?? 0), 0n),
      ),
      unknownCost: allRows.filter((x) => x.mode === type && x.unknownCost).length,
    }));
    return {
      agents,
      summary,
      activity: rows.slice(page * 20, (page + 1) * 20),
      page,
      hasOlder: rows.length > (page + 1) * 20,
      updatedAt: Date.now(),
    };
  }
  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (closing) throw fail('服务正在停止', 503);
      if (req.headers.host !== new URL(origin).host) throw fail('站点Host不匹配', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw fail('不允许跨站请求', 403);
      const url = new URL(req.url, origin),
        path = url.pathname;
      limit(req, 'requests', 180);
      if (req.method === 'GET') {
        if (path === '/api/health')
          return send(res, 200, {
            app: 'bi-trade',
            version: 2,
            liveEnabled: live.enabled,
            virtualOnly: !live.enabled,
          });
        if (path === '/api/state') {
          const s = auth.session(req);
          if (s)
            await Promise.allSettled(
              store
                .all('agents')
                .filter((a) => a.ownerId === s.owner.id && a.mode === 'live')
                .map((a) => live.balance(a)),
            );
          return send(res, 200, state(s));
        }
        if (path === '/api/public') {
          await Promise.allSettled(
            store
              .all('agents')
              .filter((a) => a.public && a.mode === 'live')
              .map((a) => live.balance(a)),
          );
          return send(res, 200, publicState(url));
        }
        if (path === '/api/leaderboard')
          return send(res, 200, leaderboard(store, paper, live, url));
        if (path === '/api/public/agent') {
          const a = store.get('agents', url.searchParams.get('id'));
          if (!a?.public || a.closedAt) throw fail('公开Agent不存在', 404);
          const dto = publicAgent(store, paper, live, a);
          return send(res, 200, {
            agent: dto,
            activity: (a.mode === 'paper'
              ? paper.fills(a.id)
              : store.forAgent('live-activity', a.id)
            )
              .sort((a, b) => b.at - a.at)
              .slice(0, 20),
          });
        }
        if (path === '/api/token') return send(res, 200, await tokenInfo());
        if (path === '/api/agent')
          return send(res, 200, {
            name: 'bi trade',
            chainId: 56,
            api: origin + '/api/agent',
            mcp: origin + '/mcp',
            liveEnabled: live.enabled,
            tools: toolsList,
            documentation: origin + '/agents.md',
          });
        if (path === '/api/markets') {
          ownerSession(req);
          return send(res, 200, {
            markets: gateway
              .markets()
              .filter(
                (m) =>
                  m.chain === 'bsc' && m.quality === 'verified' && Date.now() - m.updatedAt < 15000,
              )
              .slice(0, 50)
              .map((m) => ({
                token: m.address,
                symbol: m.symbol,
                nativeUsd: m.nativeUsd,
                priceUsd: m.priceUsd,
                at: m.updatedAt,
                venue: m.venue,
              })),
            head: gateway.statuses().find((x) => x.chain === 'bsc'),
          });
        }
        if (path === '/api/export') {
          const s = ownerSession(req),
            ids = new Set(
              store
                .all('agents')
                .filter((a) => a.ownerId === s.owner.id)
                .map((a) => a.id),
            ),
            rows = [...paper.fills(), ...store.all('live-activity')].filter((x) =>
              ids.has(x.agentId),
            );
          const cols = [
            'id',
            'agentId',
            'mode',
            'side',
            'token',
            'tokenRaw',
            'nativeRaw',
            'netRaw',
            'gasRaw',
            'at',
            'hash',
          ];
          const cell = (x) => {
            let v = String(x ?? '');
            if (/^[=+@-]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v;
            return '"' + v.replaceAll('"', '""') + '"';
          };
          res.setHeader('Content-Disposition', 'attachment; filename="bi-trade-transactions.csv"');
          return send(
            res,
            200,
            '\ufeff' +
              [cols, ...rows.map((x) => cols.map((k) => x[k]))]
                .map((r) => r.map(cell).join(','))
                .join('\r\n'),
            'text/csv; charset=utf-8',
          );
        }
        if (path === '/mcp') throw fail('此MCP服务不提供GET事件流', 405);
        const mascot = {
          '/agent-trend-v1.png': 'agent-trend-v1.png',
          '/agent-rebound-v1.png': 'agent-rebound-v1.png',
          '/agent-rotation-v1.png': 'agent-rotation-v1.png',
        }[path];
        if (mascot) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return send(res, 200, await options.assetReader(mascot), 'image/png');
        }
        const asset = {
          '/': 'intro.html',
          '/home': 'index.html',
          '/dashboard': 'index.html',
          '/docs': 'index.html',
          '/pair': 'index.html',
          '/playbook': 'index.html',
          '/intro': 'intro.html',
          '/intro.html': 'intro.html',
          '/intro.js': 'intro.js',
          '/intro.css': 'intro.css',
          '/theme.css': 'theme.css',
          '/ui-catalog.js': 'ui-catalog.js',
          '/ui-preferences.js': 'ui-preferences.js',
          '/bi-mark-preview.svg': 'bi-mark-preview.svg',
          '/home.js': 'home.js',
          '/app.js': 'app.js',
          '/style.css': 'style.css',
          '/landing.css': 'landing.css',
          '/orb.svg': 'orb.svg',
          '/agents.md': 'agents.md',
        }[path];
        if (asset)
          return send(
            res,
            200,
            await options.assetReader(asset),
            asset.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : asset.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : asset.endsWith('.svg')
                  ? 'image/svg+xml'
                  : asset.endsWith('.md')
                    ? 'text/markdown; charset=utf-8'
                    : 'text/html; charset=utf-8',
          );
        throw fail('页面不存在', 404);
      }
      if (req.method !== 'POST') throw fail('不支持此请求方式', 405);
      if (!String(req.headers['content-type']).startsWith('application/json'))
        throw fail('请求须使用application/json', 415);
      const data = await body(req);
      if (path === '/api/agent') {
        limit(req, 'agent', 60);
        fields(data, ['action', 'arguments']);
        return send(res, 200, { result: await action(req, data.action, data.arguments ?? {}) });
      }
      if (path === '/mcp') {
        limit(req, 'agent', 60);
        fields(data, ['jsonrpc', 'id', 'method', 'params']);
        if (data.jsonrpc !== '2.0') throw fail('JSON-RPC版本无效');
        let result;
        try {
          if (data.method === 'initialize')
            result = {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'bi-trade', version: '2.0.0' },
            };
          else if (data.method === 'notifications/initialized') return send(res, 202, '');
          else if (data.method === 'tools/list') result = { tools: toolsList };
          else if (data.method === 'tools/call') {
            const value = await action(req, data.params?.name, data.params?.arguments ?? {});
            result = { content: [{ type: 'text', text: json(value) }], isError: false };
          } else if (data.method === 'ping') result = {};
          else
            return send(res, 200, {
              jsonrpc: '2.0',
              id: data.id,
              error: { code: -32601, message: 'Method not found' },
            });
          return send(res, 200, { jsonrpc: '2.0', id: data.id, result });
        } catch (e) {
          return send(res, 200, {
            jsonrpc: '2.0',
            id: data.id,
            result: {
              content: [
                { type: 'text', text: json({ error: e.message, status: e.status ?? 500 }) },
              ],
              isError: true,
            },
          });
        }
      }
      if (req.headers.origin !== origin) throw fail('浏览器写入请求缺少本网站来源', 403);
      if (path === '/api/session') {
        fields(data, []);
        limit(req, 'new-session', 10, 3600000);
        let s = auth.session(req);
        if (!s) {
          const issued = auth.guest();
          cookie(res, issued.token);
          s = { owner: issued.owner, csrf: issued.csrf };
        }
        return send(res, 200, state(s));
      }
      if (path === '/api/login/challenge') {
        fields(data, ['address']);
        limit(req, 'login', 20);
        return send(res, 200, auth.challenge(data.address));
      }
      if (path === '/api/login') {
        fields(data, ['id', 'signature']);
        limit(req, 'login', 20);
        const issued = await auth.login(data.id, data.signature, auth.session(req));
        cookie(res, issued.token);
        return send(res, 200, state({ owner: issued.owner, csrf: issued.csrf }));
      }
      const s = ownerSession(req, true);
      if (path === '/api/logout') {
        fields(data, []);
        store.db.prepare('DELETE FROM credentials WHERE hash=?').run(s.hash);
        cookie(res, '');
        return send(res, 200, { ok: true });
      }
      if (path === '/api/pair') {
        fields(data, ['agentId', 'avatar']);
        return send(res, 200, pair(s, data.agentId ?? null, data.avatar ?? 'trend'));
      }
      if (path === '/api/avatar') {
        fields(data, ['agentId', 'avatar']);
        const a = own(s, data.agentId);
        a.avatar = validateAvatar(data.avatar);
        store.put('agents', a);
        return send(res, 200, agentDto(a));
      }
      if (path === '/api/agent/close' || path === '/api/agent/restore') {
        fields(data, ['agentId']);
        return send(
          res,
          200,
          path.endsWith('/close') ? archive(s, data.agentId) : restore(s, data.agentId),
        );
      }
      if (path === '/api/control') {
        fields(data, ['agentId', 'paused', 'mode', 'public']);
        let a = own(s, data.agentId);
        if (
          (data.paused !== undefined && typeof data.paused !== 'boolean') ||
          (data.public !== undefined && typeof data.public !== 'boolean') ||
          (data.mode !== undefined && !['paper', 'live'].includes(data.mode))
        )
          throw fail('账户控制参数无效');
        if (data.mode === 'live' && !s.owner.address)
          throw fail('实盘钱包功能需要钱包签名账户', 403);
        if (
          data.mode &&
          data.mode !== a.mode &&
          (live.orders(a.id).some((o) => ['preparing', 'signed', 'submitted'].includes(o.status)) ||
            paper.orders(a.id).some((o) => ['preparing', 'queued', 'quoting'].includes(o.status)))
        )
          throw fail('待处理交易尚未核对，不能切换模式', 409);
        a = {
          ...a,
          ...(data.paused !== undefined ? { paused: data.paused } : {}),
          ...(data.mode ? { mode: data.mode } : {}),
          ...(data.public !== undefined ? { public: data.public } : {}),
        };
        store.put('agents', a);
        if (a.paused) paper.pause(a.id);
        store.audit(a.ownerId, a.id, 'control', '账户控制已更新');
        return send(res, 200, agentDto(a));
      }
      if (path === '/api/strategy') {
        fields(data, ['agentId', 'name', 'description']);
        const a = own(s, data.agentId);
        if (
          typeof data.name !== 'string' ||
          !data.name.trim() ||
          data.name.length > 60 ||
          typeof data.description !== 'string' ||
          data.description.length > 600
        )
          throw fail('策略名称最多60字，说明最多600字');
        a.strategy = {
          name: data.name.trim(),
          description: data.description.trim(),
          version: (a.strategy?.version ?? 0) + 1,
        };
        store.put('agents', a);
        return send(res, 200, agentDto(a));
      }
      if (path === '/api/cancel') {
        fields(data, ['agentId', 'id']);
        const a = own(s, data.agentId),
          o = trade(a, data.id);
        if (o.mode !== 'paper') throw fail('已签名实盘交易只能核对原交易，不能取消', 409);
        return send(res, 200, paper.cancel(o.id));
      }
      if (path === '/api/policy/challenge') {
        fields(data, ['agentId', 'mode', 'tokens', 'budgetWei', 'maxGasWei', 'expiresAt']);
        const a = own(s, data.agentId);
        if (!s.owner.address) throw fail('授权策略须由钱包账户签名', 403);
        let policy = { mode: data.mode };
        if (data.mode === 'limited') {
          if (
            !Array.isArray(data.tokens) ||
            !data.tokens.length ||
            data.tokens.length > 20 ||
            !Number.isSafeInteger(data.expiresAt) ||
            data.expiresAt <= Date.now() ||
            data.expiresAt > Date.now() + 30 * 86400000
          )
            throw fail('受限策略参数无效');
          policy = {
            mode: 'limited',
            tokens: data.tokens.map(address),
            budgetWei: String(raw(data.budgetWei)),
            maxGasWei: String(raw(data.maxGasWei)),
            expiresAt: data.expiresAt,
          };
        } else if (data.mode !== 'balance') throw fail('策略模式无效');
        const target = a.id + ':' + digest(json(policy)),
          c = auth.challenge(s.owner.address, 'policy', s.owner, target);
        const message = c.message + '\n\nPolicy: ' + json(policy);
        store.db.prepare('UPDATE challenges SET message=? WHERE id=?').run(message, c.id);
        store.put('policies', { id: c.id, agentId: a.id, policy, target });
        return send(res, 200, { ...c, message });
      }
      if (path === '/api/policy') {
        fields(data, ['id', 'signature']);
        const p = store.get('policies', data.id);
        if (!p) throw fail('授权策略不存在');
        const a = own(s, p.agentId);
        await auth.verify(data.id, data.signature, 'policy', s.owner, p.target);
        a.policy = { ...p.policy, authorizedAt: Date.now() };
        store.put('agents', a);
        return send(res, 200, agentDto(a));
      }
      if (path === '/api/recovery/challenge' || path === '/api/withdraw/challenge') {
        fields(data, ['agentId', 'amountWei']);
        live.guard();
        const a = own(s, data.agentId);
        if (!s.owner.address || a.mode !== 'live')
          throw fail('须由已签名Owner账户操作实盘钱包', 403);
        const purpose = path.includes('recovery') ? 'recover' : 'withdraw';
        let target = a.id;
        if (purpose === 'withdraw')
          target = a.id + ':' + String(raw(data.amountWei)) + ':' + s.owner.address;
        const c = auth.challenge(s.owner.address, purpose, s.owner, target);
        if (purpose === 'withdraw') {
          c.message += '\nAmount (wei): ' + data.amountWei + '\nRecipient: ' + s.owner.address;
          store.db.prepare('UPDATE challenges SET message=? WHERE id=?').run(c.message, c.id);
        }
        store.put('owner-actions', {
          id: c.id,
          agentId: a.id,
          target,
          purpose,
          amountWei: data.amountWei ?? null,
        });
        return send(res, 200, c);
      }
      if (path === '/api/recovery' || path === '/api/withdraw') {
        fields(data, ['id', 'signature']);
        live.guard();
        const p = store.get('owner-actions', data.id);
        if (!p || p.purpose !== (path === '/api/recovery' ? 'recover' : 'withdraw'))
          throw fail('资金操作签名用途无效', 403);
        const a = own(s, p.agentId);
        if (recoverLocks.has(a.id)) throw fail('此钱包正在处理资金操作', 409);
        recoverLocks.add(a.id);
        try {
          await auth.verify(data.id, data.signature, p.purpose, s.owner, p.target);
          a.paused = true;
          store.put('agents', a);
          paper.pause(a.id);
          store.audit(a.ownerId, a.id, p.purpose, 'Owner资金操作已授权，Agent暂停');
          if (p.purpose === 'recover')
            return send(res, 200, {
              address: a.address,
              privateKey: vault.decrypt(a.encryptedKey, 'agent-key:' + a.id),
              paused: true,
              pending: live
                .orders(a.id)
                .filter((o) => ['signed', 'submitted'].includes(o.status))
                .map(visibleOrder),
            });
          const order = await live.submit(
            a,
            identifier(),
            { to: s.owner.address, data: '0x', value: raw(p.amountWei), kind: 'withdraw' },
            true,
          );
          return send(res, 200, visibleOrder(order));
        } finally {
          recoverLocks.delete(a.id);
        }
      }
      // A visible, real-quote demonstration; it creates no background strategy.
      if (path === '/api/demo/trade') {
        fields(data, ['agentId', 'token', 'side', 'usd', 'requestKey', 'amount']);
        const a = own(s, data.agentId);
        if (a.mode !== 'paper') throw fail('体验按钮仅支持模拟模式');
        let args, tool;
        if (data.side === 'buy') {
          const fx = paper.fx();
          if (!fx) throw fail('BNB美元参考价尚未核实', 503);
          const usd = Number(data.usd);
          if (!Number.isFinite(usd) || usd <= 0) throw fail('模拟投入须大于0，余额须足以支付费用');
          args = {
            token: address(data.token),
            amount: String(BigInt(Math.floor((usd / fx) * 1e18))),
            requestKey: data.requestKey,
            reason: 'Owner通过体验按钮测试真实报价模拟买入',
          };
          tool = 'buy_token';
        } else if (data.side === 'sell') {
          const token = address(data.token),
            amount = raw(data.amount);
          args = {
            to: ROUTER_V2,
            data: viem.encodeFunctionData({
              abi: v2Abi,
              functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
              args: [
                amount,
                0n,
                [token, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'],
                a.address,
                BigInt(Math.floor(Date.now() / 1000) + 180),
              ],
            }),
            value: '0',
            requestKey: data.requestKey,
            reason: 'Owner通过体验按钮测试真实报价模拟卖出',
          };
          tool = 'submit_transaction';
        } else throw fail('模拟方向无效');
        return send(res, 200, await execute(a, tool, args));
      }
      throw fail('接口不存在', 404);
    } catch (e) {
      send(res, e.status ?? 500, {
        error: e.status ? e.message : '服务暂时不可用，请检查服务日志',
      });
      if (!e.status) console.error('bi trade request failed:', e.message);
    }
  }
  const showcase =
    options.showcase === false
      ? null
      : new ShowcaseAgents({
          store,
          vault,
          paper,
          gateway,
          execute,
          riskGuard,
          ...(options.showcaseOptions ?? {}),
        });
  return {
    store,
    auth,
    vault,
    gateway,
    paper,
    live,
    rpc,
    showcase,
    handler,
    action,
    state,
    pair,
    register,
    origin,
    setOrigin(value) {
      origin = originUrl(value);
      auth.origin = origin;
    },
    async tick() {
      await paper.tick();
      await live.tick();
      return showcase?.tick();
    },
    async close() {
      closing = true;
      await showcase?.stop();
      gateway.stop?.();
      await Promise.allSettled([paper.stop(), live.stop()]);
      store.close?.();
    },
  };
}
