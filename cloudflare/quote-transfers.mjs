import { parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem';
import { FLAP, ZERO, address } from '../paper-terminal/src/server/adapters/types.js';
export const QUOTE_TRANSFER_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
]);
const hex = (n) => '0x' + BigInt(n).toString(16);
// Read-only, stateful RPC simulation. No balance/code/storage overrides, keys,
// signatures or broadcast: the source pool must really hold the tested amount.
// Contract senders and gas solvency are deliberately not authenticated, as in
// eth_call. This is a next-block transfer check, not a real account or swap.
export async function probeQuoteTransfers(rpc, { token, pool, recipient, amountRaw, block }) {
  token = address(token);
  pool = address(pool);
  recipient = address(recipient);
  const amount = BigInt(amountRaw);
  if (
    amount <= 0n ||
    amount >= 1n << 256n ||
    [ZERO, FLAP, pool, token].includes(recipient) ||
    pool === ZERO ||
    pool === token ||
    pool === FLAP
  )
    throw Error('报价资产转账检测参数无效');
  const parent = await rpc.block(block),
    number = parent.number + 1,
    time = Math.floor(parent.time / 1000) + 1;
  const call = (from, fn, args) => ({
    from,
    to: token,
    data: encodeFunctionData({ abi: QUOTE_TRANSFER_ABI, functionName: fn, args }),
    gas: '0x7a120',
  });
  const balance = (who) => call(recipient, 'balanceOf', [who]);
  const calls = [
    balance(pool),
    balance(recipient),
    balance(FLAP),
    call(pool, 'transfer', [recipient, amount]),
    balance(pool),
    balance(recipient),
    call(recipient, 'transfer', [FLAP, amount]),
    balance(recipient),
    balance(FLAP),
    call(FLAP, 'transfer', [recipient, amount]),
    balance(FLAP),
    balance(recipient),
    call(recipient, 'transfer', [pool, amount]),
    balance(recipient),
    balance(pool),
    balance(FLAP),
  ];
  const result = await rpc.request('eth_simulateV1', [
    {
      validation: false,
      traceTransfers: false,
      returnFullTransactions: false,
      blockStateCalls: [{ blockOverrides: { number: hex(number), time: hex(time) }, calls }],
    },
    hex(parent.number),
  ]);
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    result[0]?.parentHash?.toLowerCase() !== parent.hash.toLowerCase() ||
    Number(BigInt(result[0]?.number ?? '0x0')) !== number ||
    Number(BigInt(result[0]?.timestamp ?? '0x0')) !== time ||
    !Array.isArray(result[0]?.calls) ||
    result[0].calls.length !== calls.length
  )
    throw Error('报价资产连续模拟的区块或调用身份不一致');
  const rows = result[0].calls;
  if (rows.some((c) => c.status !== '0x1' || c.error))
    throw Error('报价资产在模拟收款地址、Flap Portal 或兑换池之间不能完成往返转账');
  for (const i of [3, 6, 9, 12])
    if (
      rows[i].returnData !== '0x' &&
      decodeFunctionResult({
        abi: QUOTE_TRANSFER_ABI,
        functionName: 'transfer',
        data: rows[i].returnData,
      }) !== true
    )
      throw Error('报价资产转账返回失败');
  const value = (i) =>
      BigInt(
        decodeFunctionResult({
          abi: QUOTE_TRANSFER_ABI,
          functionName: 'balanceOf',
          data: rows[i].returnData,
        }),
      ),
    p = value(0),
    r = value(1),
    f = value(2);
  if (
    p < amount ||
    value(4) !== p - amount ||
    value(5) !== r + amount ||
    value(7) !== r ||
    value(8) !== f + amount ||
    value(10) !== f ||
    value(11) !== r + amount ||
    value(13) !== r ||
    value(14) !== p ||
    value(15) !== f
  )
    throw Error('报价资产实际到账或扣款不一致，存在税、重基或转账限制');
  return {
    source: 'BSC RPC · eth_simulateV1',
    quality: 'estimated',
    token,
    pool,
    recipient,
    amountRaw: amount.toString(),
    parentBlock: parent.number,
    parentHash: parent.hash,
    simulatedBlock: number,
    simulatedTime: time * 1000,
    at: Date.now(),
    buyTransferTaxBps: 0,
    sellTransferTaxBps: 0,
    portalTransferTaxBps: 0,
    scope:
      'exact amount and recipient; hypothetical funding from real pool balance; no gas solvency, signatures, allowance, audit or full swap guarantee',
  };
}
