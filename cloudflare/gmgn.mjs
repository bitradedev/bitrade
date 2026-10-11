import { randomUUID, createHash } from 'node:crypto';
const HOST = 'https://openapi.gmgn.ai',
  types = [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0];
export const unwrap = (value) => value?.data ?? value;
export class GmgnHTTP {
  constructor(
    key,
    {
      fetchImpl = (...args) => fetch(...args),
      now = Date.now,
      store = null,
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = {},
  ) {
    this.key = key;
    this.fetch = fetchImpl;
    this.now = now;
    this.store = store;
    this.sleep = sleep;
    this.tail = Promise.resolve();
    const saved = store?.get('cloud-settings', 'gmgn-budget');
    this.lastAt = saved?.lastAt ?? 0;
    this.cooldown = saved?.cooldown ?? 0;
    this.spacing = Number.isFinite(saved?.spacing) ? Math.max(1000, saved.spacing) : 3000;
    this.failures = saved?.failures ?? 0;
    this.errorCode = saved?.errorCode ?? null;
    this.lastSuccessAt = saved?.lastSuccessAt ?? null;
    this.keyId = createHash('sha256')
      .update(key ?? '')
      .digest('hex')
      .slice(0, 24);
    this.cache = new Map();
  }
  status() {
    return {
      limited: this.now() < this.cooldown,
      retryAt: this.cooldown || null,
      errorCode: this.errorCode,
      consecutiveLimits: this.failures,
      spacingMs: this.spacing,
      minimumSpacingMs: 1000,
      sharedQueue: true,
      lastSuccessAt: this.lastSuccessAt,
    };
  }
  saveBudget() {
    this.store?.put('cloud-settings', {
      id: 'gmgn-budget',
      lastAt: this.lastAt,
      cooldown: this.cooldown,
      spacing: this.spacing,
      failures: this.failures,
      errorCode: this.errorCode,
      lastSuccessAt: this.lastSuccessAt,
    });
  }
  limited(response, body) {
    const now = this.now(),
      candidate = String(body?.error?.code ?? body?.error ?? body?.code ?? '');
    this.errorCode = /^[A-Z_0-9]{1,80}$/.test(candidate) ? candidate : 'RATE_LIMIT';
    this.failures++;
    // Obey every valid server deadline, including Retry-After. Repeated bans get
    // exponential backoff; restart and concurrent consumers cannot reset it.
    const deadlines = [
      body?.reset_at,
      body?.data?.reset_at,
      body?.error?.reset_at,
      response.headers.get('X-RateLimit-Reset'),
    ]
      .map(Number)
      .filter((x) => Number.isFinite(x) && x * 1000 > now && x * 1000 < now + 31 * 86400000)
      .map((x) => x * 1000 + 5000);
    const retry = response.headers.get('Retry-After');
    if (retry) {
      const at = /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
      if (Number.isFinite(at) && at > now && at < now + 31 * 86400000) deadlines.push(at + 5000);
    }
    const base = this.errorCode === 'RATE_LIMIT_BANNED' ? 300000 : 65000;
    const backoff = Math.min(3600000, base * 2 ** Math.min(this.failures - 1, 8));
    this.cooldown = Math.max(now + backoff, ...deadlines);
    this.spacing = Math.min(15000, Math.max(5000, this.spacing * 2));
    this.saveBudget();
    throw Error('GMGN 行情限频，等待额度恢复后自动重试');
  }
  request(path, params, body) {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (!this.key) throw Error('尚未配置 GMGN 行情密钥');
        if (this.now() < this.cooldown) throw Error('GMGN 行情限频，等待额度恢复后自动重试');
        const wait = Math.max(0, Math.max(1000, this.spacing) - (this.now() - this.lastAt));
        if (wait) await this.sleep(wait);
        this.lastAt = this.now();
        this.saveBudget();
        const url = new URL(path, HOST);
        for (const [k, v] of Object.entries({
          ...params,
          timestamp: Math.floor(this.now() / 1000),
          client_id: randomUUID(),
        }))
          url.searchParams.set(k, String(v));
        const response = await this.fetch(url, {
          method: body ? 'POST' : 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
          headers: {
            'X-APIKEY': this.key,
            'Content-Type': 'application/json',
            'User-Agent': 'bitrade-cloud/0.3',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (response.status === 429) {
          let body;
          try {
            body = await response.json();
          } catch {}
          this.limited(response, body);
        }
        if (response.status === 401 || response.status === 403) {
          this.cooldown = this.now() + 300000;
          this.errorCode = 'AUTHORIZATION_REQUIRED';
          this.saveBudget();
          throw Error('GMGN 行情认证或访问权限未通过，暂停请求后重试');
        }
        if (!response.ok) throw Error('GMGN 行情请求失败：HTTP ' + response.status);
        const data = await response.json();
        if (Number(data.code) === 429) this.limited(response, data);
        if (data.code !== undefined && Number(data.code) !== 0 && Number(data.code) !== 200)
          throw Error('GMGN 行情返回错误');
        this.cooldown = 0;
        this.failures = 0;
        this.errorCode = null;
        // Recover pacing gradually after successful reads. A previous ban must
        // not leave a permanent 15-second interval that starves fresh risk evidence.
        this.spacing = Math.max(3000, Math.ceil(this.spacing * 0.8));
        this.lastSuccessAt = this.now();
        this.saveBudget();
        return { ...data, _bitradeReadAt: this.lastSuccessAt };
      });
    this.tail = task;
    return task;
  }
  cached(name, address, ttl, load) {
    const id = this.keyId + ':' + name + ':' + address,
      old = this.cache.get(id);
    if (old && this.now() - old.at >= 0 && this.now() - old.at < ttl) return old.task;
    const saved = this.store?.get('cloud-gmgn-cache', id);
    if (saved && this.now() - saved.at >= 0 && this.now() - saved.at < ttl)
      return Promise.resolve(saved.value);
    const task = load()
      .then((value) => {
        const at = value._bitradeReadAt;
        this.store?.put('cloud-gmgn-cache', { id, at, value });
        this.cache.set(id, { at, task: Promise.resolve(value) });
        return value;
      })
      .catch((e) => {
        this.cache.delete(id);
        throw e;
      });
    this.cache.set(id, { at: this.now(), task });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return task;
  }
  info(chain, address) {
    return this.cached('info', chain + ':' + address, 60000, () =>
      this.request('/v1/token/info', { chain, address }),
    );
  }
  security(chain, address) {
    return this.cached('security', chain + ':' + address, 90000, () =>
      this.request('/v1/token/security', { chain, address }),
    );
  }
  holders(chain, address) {
    return this.cached('holders', chain + ':' + address, 90000, () =>
      this.request('/v1/market/token_top_holders', {
        chain,
        address,
        limit: 100,
        order_by: 'amount_percentage',
        direction: 'desc',
      }),
    );
  }
  trenches() {
    const section = {
      filters: ['offchain', 'onchain'],
      launchpad_platform_v2: true,
      limit: 8,
      quote_address_type: types,
    };
    return this.cached('trenches', 'bsc', 300000, () =>
      this.request(
        '/v1/trenches',
        { chain: 'bsc' },
        { version: 'v2', new_creation: section, near_completion: section, completed: section },
      ),
    );
  }
  close() {}
}
