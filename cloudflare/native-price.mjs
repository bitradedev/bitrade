// BSC standard BNB/USD proxy, verified against Chainlink's official feed directory.
// https://data.chain.link/feeds/bsc/mainnet/bnb-usd
export const BNB_USD_FEED = '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
const ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'description',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
];
export class NativePrice {
  constructor(rpc, { now = Date.now } = {}) {
    this.rpc = rpc;
    this.now = now;
    this.pending = null;
  }
  read() {
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async load() {
    const block = await this.rpc.block();
    if (Math.abs(this.now() - block.time) > 15000) throw Error('BNB 报价的链头已过期');
    if (this.decimals === undefined) {
      const description = await this.rpc.read(BNB_USD_FEED, ABI, 'description', [], block.number);
      const decimals = Number(await this.rpc.read(BNB_USD_FEED, ABI, 'decimals', [], block.number));
      if (description !== 'BNB / USD' || decimals !== 8) throw Error('BNB 美元预言机身份未核实');
      this.decimals = decimals;
    }
    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await this.rpc.read(
      BNB_USD_FEED,
      ABI,
      'latestRoundData',
      [],
      block.number,
    );
    const at = Number(updatedAt) * 1000,
      usd = Number(answer) / 10 ** this.decimals;
    if (
      roundId <= 0n ||
      answer <= 0n ||
      answeredInRound < roundId ||
      startedAt > updatedAt ||
      !Number.isSafeInteger(at) ||
      at <= 0 ||
      at > block.time ||
      this.now() - at < 0 ||
      this.now() - at >= 90000 ||
      !Number.isFinite(usd) ||
      usd <= 0
    )
      throw Error('BNB 美元预言机价格无效或已过期');
    return {
      id: 'native-fx',
      usd,
      at,
      readAt: this.now(),
      block: block.number,
      source: 'Chainlink BNB/USD · BSC',
      feed: BNB_USD_FEED,
      roundId: String(roundId),
    };
  }
}
