import { randomBytes } from 'node:crypto';
import { viem } from './dependencies.mjs';
import { digest, identifier, fail } from './database-core.mjs';
export const COOKIE = 'bi_trade_session';
export const PAPER_SESSION_SECONDS = 30 * 86400;
export function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value))
    throw fail('钱包地址无效');
  return value.toLowerCase();
}
export class OwnerAuth {
  constructor(store, origin, network = { name: 'BNB Chain', chainId: 56 }) {
    this.network = network;
    this.store = store;
    this.origin = origin;
  }
  session(req) {
    const token = String(req.headers.cookie ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1);
    if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const c = this.store.db
      .prepare('SELECT * FROM credentials WHERE hash=? AND kind=? AND expires>?')
      .get(digest(token), 'owner', Date.now());
    if (!c) return null;
    const owner = this.store.get('owners', c.owner);
    return owner ? { owner, csrf: c.csrf, hash: c.hash, token } : null;
  }
  issue(owner) {
    const token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(24).toString('base64url');
    const maxAge = owner.kind === 'demo' ? PAPER_SESSION_SECONDS : 86400;
    this.store.db
      .prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?)')
      .run(digest(token), 'owner', owner.id, null, Date.now() + maxAge * 1000, csrf);
    return { token, csrf, owner, maxAge };
  }
  renewDemo(session) {
    if (session.owner.kind !== 'demo') return null;
    const result = this.store.db
      .prepare('UPDATE credentials SET expires=? WHERE hash=? AND kind=? AND owner=? AND expires>?')
      .run(
        Date.now() + PAPER_SESSION_SECONDS * 1000,
        session.hash,
        'owner',
        session.owner.id,
        Date.now(),
      );
    return result.changes ? { token: session.token, maxAge: PAPER_SESSION_SECONDS } : null;
  }
  guest() {
    const owner = { id: identifier(), address: null, createdAt: Date.now(), kind: 'demo' };
    this.store.put('owners', owner);
    return this.issue(owner);
  }
  challenge(value, purpose = 'login', owner = null, target = null) {
    const a = address(value),
      id = identifier(),
      now = Date.now(),
      expires = now + 300000,
      domain = new URL(this.origin).host;
    const statement =
      purpose === 'login'
        ? 'Sign in to bi trade on ' +
          this.network.name +
          '. This signature does not transfer funds.'
        : purpose === 'recover'
          ? 'Recover the private key for Agent ' + target + ' and pause it.'
          : purpose === 'policy'
            ? 'Authorize the trading policy for Agent ' + target + '.'
            : 'Authorize a withdrawal to your registered wallet for Agent ' + target + '.';
    const message =
      domain +
      ' wants you to sign in with your Ethereum account:\n' +
      viem.getAddress(a) +
      '\n\n' +
      statement +
      '\n\nURI: ' +
      this.origin +
      '\nVersion: 1\nChain ID: ' +
      this.network.chainId +
      '\nNonce: ' +
      id +
      '\nIssued At: ' +
      new Date(now).toISOString() +
      '\nExpiration Time: ' +
      new Date(expires).toISOString();
    this.store.db
      .prepare(
        'INSERT INTO challenges(id,owner,address,purpose,target,message,expires) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, owner?.id ?? null, a, purpose, target, message, expires);
    return { id, message, address: a, chainId: this.network.chainId, expiresAt: expires };
  }
  async verify(id, signature, purpose, owner = null, target = null) {
    if (
      typeof id !== 'string' ||
      typeof signature !== 'string' ||
      !/^0x[0-9a-f]{128,130}$/i.test(signature)
    )
      throw fail('签名参数无效');
    const row = this.store.db.prepare('SELECT * FROM challenges WHERE id=?').get(id);
    if (
      !row ||
      row.used ||
      !row.message.includes('\nChain ID: ' + this.network.chainId + '\n') ||
      row.expires <= Date.now() ||
      row.purpose !== purpose ||
      row.owner !== (owner?.id ?? null) ||
      row.target !== target
    )
      throw fail('签名请求已失效或用途不匹配', 403);
    if (
      !(await viem
        .verifyMessage({ address: row.address, message: row.message, signature })
        .catch(() => false))
    )
      throw fail('钱包签名验证失败', 403);
    const result = this.store.db
      .prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires>?')
      .run(id, Date.now());
    if (!result.changes) throw fail('该签名请求已使用', 403);
    return row.address;
  }
  async login(id, signature, current) {
    const a = await this.verify(id, signature, 'login');
    return this.store.transaction(() => {
      // Verification yields: another login, logout or expiry may have changed
      // this browser's demo session. Only its current unbound owner can migrate.
      const credential = current
          ? this.store.db
              .prepare('SELECT owner FROM credentials WHERE hash=? AND kind=? AND expires>?')
              .get(current.hash, 'owner', Date.now())
          : null,
        demo =
          credential && credential.owner === current?.owner.id
            ? this.store.get('owners', credential.owner)
            : null;
      let owner = this.store.all('owners').find((x) => x.address === a);
      if (!owner && demo?.kind === 'demo' && demo.address === null) {
        owner = { ...demo, address: a, kind: 'wallet' };
        this.store.put('owners', owner);
      } else if (!owner) {
        owner = { id: identifier(), address: a, kind: 'wallet', createdAt: Date.now() };
        this.store.put('owners', owner);
      }
      if (current)
        this.store.db
          .prepare('DELETE FROM credentials WHERE hash=? AND kind=?')
          .run(current.hash, 'owner');
      return this.issue(owner);
    });
  }
  agent(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw fail('需要Agent访问凭据', 401);
    const token = header.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('Agent凭据无效', 401);
    const c = this.store.db
      .prepare('SELECT * FROM credentials WHERE hash=? AND kind=? AND expires>?')
      .get(digest(token), 'agent', Date.now());
    if (!c) throw fail('Agent凭据已撤销或失效', 401);
    const agent = this.store.get('agents', c.agent);
    if (!agent || agent.ownerId !== c.owner || agent.closedAt)
      throw fail('Agent凭据绑定无效或账户已关闭', 401);
    return agent;
  }
}
