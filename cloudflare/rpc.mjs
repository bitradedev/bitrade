import { encodeFunctionData, decodeFunctionResult } from 'viem';
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
    { fetchImpl = (...args) => fetch(...args), receiptUrl = null } = {},
  ) {
    this.url = publicEndpoint(url);
    this.fetch = fetchImpl;
    this.chain = 'bsc';
    this.cache = new Map();
    this.pending = new Map();
    this.id = 0;
    this.tail = Promise.resolve();
    this.receiptRpc =
      receiptUrl && publicEndpoint(receiptUrl) !== this.url
        ? new CloudRpc(receiptUrl, { fetchImpl })
        : null;
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
        throw Error(
          /too many subrequests|subrequest limit/i.test(String(e?.message))
            ? '云端单轮请求上限已到，下一轮自动重试'
            : 'BSC RPC 网络不可用',
        );
      }
      if (!r.ok) throw Error('BSC RPC 请求失败：HTTP ' + r.status);
      const data = await r.json();
      if (data.error || !Object.hasOwn(data, 'result')) throw Error('BSC RPC 未返回有效读取结果');
      return data.result;
    };
    // Shared bounded concurrency avoids public RPC bursts from route discovery.
    const task = this.tail.catch(() => {}).then(execute);
    this.tail = task;
    return task;
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
    if (this.pending.has(id)) return this.pending.get(id);
    const p = this.request('eth_call', params)
      .then((data) => decodeFunctionResult({ abi, functionName: fn, data }))
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
      throw Error(
        /too many subrequests|subrequest limit/i.test(String(e?.message))
          ? '云端单轮请求上限已到，下一轮自动重试'
          : 'BSC 回执批次网络不可用',
      );
    }
    if (!response.ok) throw Error('BSC 回执批次读取失败：HTTP ' + response.status);
    const rows = await response.json();
    if (
      !Array.isArray(rows) ||
      rows.length !== requests.length ||
      new Set(rows.map((r) => r.id)).size !== rows.length
    )
      throw Error('BSC 回执批次身份未核实');
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
