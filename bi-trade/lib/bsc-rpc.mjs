import {viem,chains} from './dependencies.mjs';
import {fail} from './database.mjs';
export const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const ROUTER_V2='0x10ed43c718714eb63d5aa57b78b54704e256024e';
export const FACTORY_V2='0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
export const ROUTER_V3='0x1b81d678ffb9c0263b24a97847620c99d213eb14';
export const FACTORY_V3='0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
export const QUOTER_V3='0xb048bbc1ee6b733fffcfb9e9cef7375518e25997';
export const v2Abi=viem.parseAbi(['function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])','function WETH() view returns (address)','function factory() view returns (address)','function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])','function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable','function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])','function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)']);
export const v3Abi=viem.parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)','function multicall(bytes[] data) payable returns (bytes[])','function refundETH() payable','function unwrapWETH9(uint256 amountMinimum,address recipient) payable']);
export const erc20Abi=viem.parseAbi(['function balanceOf(address) view returns (uint256)','function decimals() view returns (uint8)','function approve(address spender,uint256 amount) returns (bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
export class BscRpc{
 constructor(url='https://bsc-dataseed.bnbchain.org'){const u=new URL(url);if(u.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(u.hostname))throw Error('BSC RPC须使用HTTPS');this.url=url;this.client=viem.createPublicClient({chain:chains.bsc,transport:viem.http(url,{timeout:6000,retryCount:0})});this.checkedAt=0;}
 async verify(){if(Date.now()-this.checkedAt<10000)return;if(await this.client.getChainId()!==56)throw fail('RPC返回了非BSC网络',503);this.checkedAt=Date.now();}
 async balance(a){await this.verify();return this.client.getBalance({address:a});}
 async buyTransaction(agent,token,amount){await this.verify();const path=[WBNB,token],deadline=BigInt(Math.floor(Date.now()/1000)+180);
  const pair=await this.client.readContract({address:FACTORY_V2,abi:viem.parseAbi(['function getPair(address,address) view returns (address)']),functionName:'getPair',args:path});
  if(pair!=='0x0000000000000000000000000000000000000000'){
   const [wrapped,factory,amounts]=await Promise.all([this.client.readContract({address:ROUTER_V2,abi:v2Abi,functionName:'WETH'}),this.client.readContract({address:ROUTER_V2,abi:v2Abi,functionName:'factory'}),this.client.readContract({address:ROUTER_V2,abi:v2Abi,functionName:'getAmountsOut',args:[amount,path]})]);
   if(wrapped.toLowerCase()!==WBNB||factory.toLowerCase()!==FACTORY_V2||amounts[1]<=0n)throw fail('Pancake V2路线核验失败');
   return {to:ROUTER_V2,data:viem.encodeFunctionData({abi:v2Abi,functionName:'swapExactETHForTokensSupportingFeeOnTransferTokens',args:[amounts[1]*99n/100n,path,agent.address,deadline]}),value:amount,kind:'buy',token,venue:'pancake-v2'};
  }
  const fa=viem.parseAbi(['function getPool(address,address,uint24) view returns (address)']),qa=viem.parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
  let best=null;for(const fee of [100,500,2500,10000]){const pool=await this.client.readContract({address:FACTORY_V3,abi:fa,functionName:'getPool',args:[WBNB,token,fee]});if(pool==='0x0000000000000000000000000000000000000000')continue;try{const result=await this.client.simulateContract({address:QUOTER_V3,abi:qa,functionName:'quoteExactInputSingle',args:[{tokenIn:WBNB,tokenOut:token,amountIn:amount,fee,sqrtPriceLimitX96:0n}]});if(result.result[0]>0n&&(!best||result.result[0]>best.output))best={fee,output:result.result[0]};}catch{}}
  if(!best)throw fail('没有已核实的Pancake V2/V3购买路线');
  const swap=viem.encodeFunctionData({abi:v3Abi,functionName:'exactInputSingle',args:[{tokenIn:WBNB,tokenOut:token,fee:best.fee,recipient:agent.address,deadline,amountIn:amount,amountOutMinimum:best.output*99n/100n,sqrtPriceLimitX96:0n}]});
  return {to:ROUTER_V3,data:viem.encodeFunctionData({abi:v3Abi,functionName:'multicall',args:[[swap,viem.encodeFunctionData({abi:v3Abi,functionName:'refundETH'})]]}),value:amount,kind:'buy',token,venue:'pancake-v3'};
 }
 async prepare(agent,tx){await this.verify();const code=tx.data==='0x'?null:await this.client.getCode({address:tx.to});if(tx.data!=='0x'&&(!code||code==='0x'))throw fail('目标地址没有合约代码');const [balance,gas,gasPrice,nonce]=await Promise.all([this.balance(agent.address),this.client.estimateGas({account:agent.address,to:tx.to,data:tx.data,value:tx.value}),this.client.getGasPrice(),this.client.getTransactionCount({address:agent.address,blockTag:'pending'})]);const gasLimit=gas*120n/100n;if(gasLimit>3000000n)throw fail('交易Gas估计超过支持上限');if(tx.value+gasLimit*gasPrice>balance)throw fail('Agent钱包BNB不足以支付金额和Gas');return {...tx,gas:gasLimit,gasPrice,nonce,chainId:56,type:'legacy'};}
 async broadcast(raw){await this.verify();return this.client.sendRawTransaction({serializedTransaction:raw});}
 async receipt(hash){await this.verify();return this.client.getTransactionReceipt({hash}).catch(e=>{if(e.name==='TransactionReceiptNotFoundError')return null;throw e;});}
 async transaction(hash){await this.verify();return this.client.getTransaction({hash});}
 async block(number){await this.verify();return this.client.getBlock({blockNumber:BigInt(number)});}
}
