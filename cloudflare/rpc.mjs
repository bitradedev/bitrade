import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { createHash } from 'node:crypto';
import { retryAfter } from './retry-after.mjs';
const ALLOWED = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockReceipts',
  'eth_getLogs',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getCode',
  'eth_call',
  'eth_gasPrice',
]);
// BNB Chain's public endpoint supports prices/blocks, but disables getLogs.
const BACKUP_ALLOWED = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getCode',
  'eth_call',
  'eth_gasPrice',
]);
export const hexBlock = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid block number');
  return '0x' + n.toString(16);
};
export function publicEndpoint(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.hash ||
    u.hostname === 'localhost' ||
    u.hostname.endsWith('.local') ||
    u.hostname.startsWith('[') ||
    /^\d+(\.\d+){3}$/.test(u.hostname)
  )
    throw Error('RPC 必须使用公开 HTTPS 地址');
  return u.href;
}
export class CloudRpc {
  constructor(
    url = 'https://bsc-rpc.publicnode.com',
    {
      fetchImpl = (...args) => fetch(...args),
      receiptUrl = null,
      backupUrl = null,
      store = null,
      now = Date.now,
    } = {},
  ) {
    this.url = publicEndpoint(url);
    this.fetch = fetchImpl;
    this.chain = 'bsc';
    this.cache = new Map();
    this.pending = new Map();
    this.id = 0;
    this.tail = Promise.resolve();
    this.store = store;
    this.now = now;
    this.budgetId = 'rpc-budget-' + createHash('sha256').update(this.url).digest('hex');
    this.cooldown = store?.get('cloud-settings', this.budgetId) ?? { retryAt: 0 };
    this.receiptRpc =
      receiptUrl && publicEndpoint(receiptUrl) !== this.url
        ? new CloudRpc(receiptUrl, { fetchImpl, store, now })
        : null;
    this.backupRpc =
      backupUrl && publicEndpoint(backupUrl) !== this.url
        ? this.receiptRpc?.url === publicEndpoint(backupUrl)
          ? this.receiptRpc
          : new CloudRpc(backupUrl, { fetchImpl, store, now })
        : null;
    this.activeSource = 'primary';
    this.backupVerification = null;
    this.backupAnchors = new Map();
    this.backupAnchorChecks = new Map();
  }
  sourceStatus() {
    return {
      retryAt: this.cooldown.retryAt ?? 0,
      limited: this.now() < (this.cooldown.retryAt ?? 0),
      lastError: this.cooldown.lastError ?? null,
      lastFailure: this.cooldown.lastFailure ?? null,
      lastSuccessAt: this.cooldown.lastSuccessAt ?? null,
    };
  }
  status() {
    const primary = this.sourceStatus();
    if (!this.backupRpc) return primary;
    const backup = this.backupRpc.sourceStatus();
    return {
      ...primary,
      primary,
      backup,
      activeSource: this.activeSource,
      limited: primary.limited && backup.limited,
      retryAt: primary.limited && backup.limited ? Math.min(primary.retryAt, backup.retryAt) : 0,
    };
  }
  statusFor(method) {
    return BACKUP_ALLOWED.has(method) ? this.status() : this.sourceStatus();
  }
  #save(state) {
    this.cooldown = { ...state, id: this.budgetId };
    this.store?.put('cloud-settings', this.cooldown);
  }
  #failed(response, message) {
    if (response.status === 429) {
      const at = this.now(),
        retry = retryAfter(response.headers.get('Retry-After'), at);
      this.#save({
        ...this.cooldown,
        retryAt: Math.max(at + 15000, retry.at === null ? 0 : retry.at + 5000),
        lastError: 'HTTP 429',
        lastFailure: { at, status: 429, serverRetryAt: retry.at },
      });
    }
    return Object.assign(Error(message + '：HTTP ' + response.status), {
      rpcUnavailable: [403, 429, 500, 502, 503, 504].includes(response.status),
    });
  }
  #recovered() {
    if (this.cooldown.retryAt > 0)
      this.#save({ ...this.cooldown, retryAt: 0, lastError: null, lastSuccessAt: this.now() });
  }
  #queued(execute) {
    const task = this.tail
      .catch(() => {})
      .then(() => {
        if (this.sourceStatus().limited)
          throw Object.assign(Error('BSC RPC 限频冷却中，稍后自动重试'), { rpcUnavailable: true });
        return execute();
      });
    this.tail = task;
    return task;
  }
  async request(method, params = []) {
    if (!ALLOWED.has(method)) throw Error('Cloud RPC is read-only');
    const execute = async () => {
      let r;
      try {
        r = await this.fetch(this.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        });
      } catch (e) {
        const local =
          e?.code === 'CF_SUBREQUEST_BUDGET' ||
          /too many subrequests|subrequest limit/i.test(String(e?.message));
        throw Object.assign(
          Error(local ? '云端单轮请求上限已到，下一轮自动重试' : 'BSC RPC 网络不可用'),
          { rpcUnavailable: !local, ...(local ? { code: 'CF_SUBREQUEST_BUDGET' } : {}) },
        );
      }
      if (!r.ok) throw this.#failed(r, 'BSC RPC 请求失败');
      const data = await r.json();
      if (data.error || !Object.hasOwn(data, 'result')) throw Error('BSC RPC 未返回有效读取结果');
      this.#recovered();
      this.activeSource = 'primary';
      return data.result;
    };
    // Shared bounded concurrency avoids public RPC bursts from route discovery.
    return this.#queued(execute).catch((error) => {
      if (!error.rpcUnavailable || !this.backupRpc || !BACKUP_ALLOWED.has(method)) throw error;
      return this.#backupRequest(method, params);
    });
  }
  async #backupRequest(method, params) {
    const client = this.backupRpc;
    if (!client.verified) {
      if (!this.backupVerification)
        this.backupVerification = client
          .request('eth_chainId')
          .then((chain) => {
            if (BigInt(chain) !== 56n) throw Error('备用 RPC 并非 BSC 主网');
            client.verified = true;
          })
          .finally(() => {
            this.backupVerification = null;
          });
      await this.backupVerification;
    }
    const fixed = method === 'eth_call' || method === 'eth_getCode' ? params[1] : null;
    if (typeof fixed === 'string' && /^0x[0-9a-f]+$/i.test(fixed)) {
      const number = Number(BigInt(fixed)),
        anchor = this.cache.get(number),
        old = this.backupAnchors.get(number);
      if (anchor && (!old || old.hash !== anchor.hash || this.now() - old.at >= 5000)) {
        const key = number + ':' + anchor.hash;
        let task = this.backupAnchorChecks.get(key);
        if (!task) {
          task = client
            .block(number, true)
            .then((secondary) => {
              if (
                secondary.number !== number ||
                secondary.hash !== anchor.hash ||
                this.cache.get(number)?.hash !== anchor.hash
              )
                throw Error('备用 RPC 与报价区块不一致，等待重新核价');
              this.backupAnchors.set(number, { hash: anchor.hash, at: this.now() });
              if (this.backupAnchors.size > 64)
                this.backupAnchors.delete(this.backupAnchors.keys().next().value);
            })
            .finally(() => this.backupAnchorChecks.delete(key));
          this.backupAnchorChecks.set(key, task);
        }
        await task;
      }
    }
    const result = await client.request(method, params);
    this.activeSource = 'backup';
    return result;
  }
  async read(token, abi, fn, args = [], block, from) {
    const params = [
        {
          to: token,
          ...(from ? { from } : {}),
          data: encodeFunctionData({ abi, functionName: fn, args }),
        },
        block === undefined ? 'latest' : hexBlock(block),
      ],
      id = JSON.stringify(params);
    const anchor = Number.isSafeInteger(block) ? this.cache.get(block)?.hash : null,
      cacheKey = anchor ? id + ':' + anchor : null;
    this.readCache ??= new Map();
    const old = cacheKey ? this.readCache.get(cacheKey) : null;
    if (old && this.now() - old.at >= 0 && this.now() - old.at < 30000) return old.value;
    if (this.pending.has(id)) return this.pending.get(id);
    const p = this.request('eth_call', params)
      .then((data) => {
        const value = decodeFunctionResult({ abi, functionName: fn, data });
        if (cacheKey && this.cache.get(block)?.hash === anchor) {
          this.readCache.set(cacheKey, { at: this.now(), value });
          while (this.readCache.size > 512)
            this.readCache.delete(this.readCache.keys().next().value);
        }
        return value;
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }
  async block(number, force = false) {
    if (!this.verified) {
      if (BigInt(await this.request('eth_chainId')) !== 56n) throw Error('RPC 并非 BSC 主网');
      this.verified = true;
    }
    if (number !== undefined && !force && this.cache.has(number)) return this.cache.get(number);
    const raw = await this.request('eth_getBlockByNumber', [
      number === undefined ? 'latest' : hexBlock(number),
      false,
    ]);
    if (!raw?.hash || !Array.isArray(raw.transactions)) throw Error('BSC 区块读取失败');
    const b = {
      number: Number(BigInt(raw.number)),
      hash: raw.hash,
      parentHash: raw.parentHash,
      time: Number(BigInt(raw.timestamp)) * 1000,
      transactions: raw.transactions,
    };
    this.cache.set(b.number, b);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return b;
  }
  knownBlock(number) {
    return this.cache.get(number);
  }
  async receipt(hash) {
    if (!this.receiptRpc) return this.request('eth_getTransactionReceipt', [hash]);
    // Publicnode's anonymous endpoint denies receipts as archive requests.
    // Use BNB Chain's explicitly configured public receipt endpoint, while
    // binding every sample back to the exact primary chain's canonical block.
    const raw = await this.receiptRpc.request('eth_getTransactionReceipt', [hash]);
    return this.confirmReceipt(hash, raw);
  }
  async confirmReceipt(hash, raw) {
    if (!raw) return null;
    if (
      typeof raw.transactionHash !== 'string' ||
      raw.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      !/^0x[0-9a-f]+$/i.test(raw.blockNumber ?? '') ||
      !/^0x[0-9a-f]{64}$/i.test(raw.blockHash ?? '')
    )
      throw Error('BSC 回执身份未核实');
    const block = Number(BigInt(raw.blockNumber)),
      [primary, secondary] = await Promise.all([this.block(block), this.receiptRpc.block(block)]);
    if (primary.hash !== secondary.hash || raw.blockHash !== primary.hash)
      throw Error('BSC 回执节点与报价节点的区块不一致');
    return raw;
  }
  async receipts(hashes) {
    if (
      !Array.isArray(hashes) ||
      !hashes.length ||
      hashes.length > 12 ||
      hashes.some((h) => typeof h !== 'string' || !/^0x[0-9a-f]{64}$/i.test(h)) ||
      new Set(hashes).size !== hashes.length
    )
      throw Error('BSC 回执批次无效');
    if (!this.receiptRpc) return Promise.all(hashes.map((h) => this.receipt(h)));
    const client = this.receiptRpc,
      requests = hashes.map((hash) => ({
        jsonrpc: '2.0',
        id: ++client.id,
        method: 'eth_getTransactionReceipt',
        params: [hash],
      }));
    const rows = await client.#queued(async () => {
      let response;
      try {
        response = await client.fetch(client.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requests),
        });
      } catch (e) {
        const local =
          e?.code === 'CF_SUBREQUEST_BUDGET' ||
          /too many subrequests|subrequest limit/i.test(String(e?.message));
        throw Object.assign(
          Error(local ? '云端单轮请求上限已到，下一轮自动重试' : 'BSC 回执批次网络不可用'),
          local ? { code: 'CF_SUBREQUEST_BUDGET' } : {},
        );
      }
      if (!response.ok) throw client.#failed(response, 'BSC 回执批次读取失败');
      const rows = await response.json();
      if (
        !Array.isArray(rows) ||
        rows.length !== requests.length ||
        new Set(rows.map((r) => r.id)).size !== rows.length
      )
        throw Error('BSC 回执批次身份未核实');
      for (const request of requests) {
        const row = rows.find((r) => r.id === request.id);
        if (!row || row.error || !Object.hasOwn(row, 'result'))
          throw Error('BSC 回执批次未返回有效数据');
      }
      client.#recovered();
      return rows;
    });
    const results = [];
    for (let i = 0; i < requests.length; i++) {
      const row = rows.find((r) => r.id === requests[i].id);
      if (!row || row.error || !Object.hasOwn(row, 'result'))
        throw Error('BSC 回执批次未返回有效数据');
      results.push(await this.confirmReceipt(hashes[i], row.result));
    }
    return results;
  }
  logs(filter) {
    return this.request('eth_getLogs', [filter]);
  }
  promote() {}
  linkPending(p) {
    return p;
  }
  withPriority(fn) {
    return fn();
  }
  withBackground(fn) {
    return fn();
  }
  close() {}
}
