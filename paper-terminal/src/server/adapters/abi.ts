import { parseAbi } from 'viem';
export const ERC20=parseAbi(['function decimals() view returns (uint8)','function name() view returns (string)','function symbol() view returns (string)','function balanceOf(address) view returns (uint256)']);
export const FLAP_ABI=parseAbi([
 'struct State {uint8 status;uint256 reserve;uint256 circulatingSupply;uint256 price;uint8 tokenVersion;uint256 r;uint256 h;uint256 k;uint256 dexSupplyThresh;address quoteTokenAddress;bool nativeToQuoteSwapEnabled;bytes32 extensionID;uint256 buyTaxRate;uint256 sellTaxRate;address pool;uint256 progress;uint8 lpFeeProfile;uint8 dexId;}',
 'function getTokenV8Safe(address token) view returns (State)',
 'function getFeeRate() view returns (uint256 buyFeeRate,uint256 sellFeeRate)',
 'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) params) returns (uint256 outputAmount)',
]);
export const FOUR_ABI=parseAbi([
 'function getTokenInfo(address token) view returns (uint256 version,address tokenManager,address quote,uint256 lastPrice,uint256 tradingFeeRate,uint256 minTradingFee,uint256 launchTime,uint256 offers,uint256 maxOffers,uint256 funds,uint256 maxFunds,bool liquidityAdded)',
 'function tryBuy(address token,uint256 amount,uint256 funds) view returns (address tokenManager,address quote,uint256 estimatedAmount,uint256 estimatedCost,uint256 estimatedFee,uint256 amountMsgValue,uint256 amountApproval,uint256 amountFunds)',
 'function trySell(address token,uint256 amount) view returns (address tokenManager,address quote,uint256 funds,uint256 fee)',
 'function _tokenInfos(address token) view returns ((address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status) info)',
 'function feeRateBuy() view returns (uint256)','function feeRateSell() view returns (uint256)','function feeRate() view returns (uint256)',
]);
export const PONS_V2_ABI=parseAbi([
 'struct Launch {address token;address curve;address deployer;address creatorFeeRecipient;address pairToken;uint256 graduationThreshold;uint24 poolFee;int24 tickSpacing;uint16 creatorTaxBps;bool buybackEnabled;uint8 phase;uint256 sweptQuote;uint256 sweptTokens;uint256 sweptAt;bool exists;}',
 'function getLaunchedToken(address token) view returns (Launch)',
 'function memeHook() view returns (address)','function poolManager() view returns (address)',
 'function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)',
 'function sellableTokens() view returns (uint256)','function feeBps() view returns (uint256)','function creatorTaxBps() view returns (uint256)',
 'function currentSnipeTaxBps(address recipient) view returns (uint256)','function readyToGraduate() view returns (bool)','function graduated() view returns (bool)',
 'function launches(bytes32 id) view returns (bool registered,bool memecoinIsCurrency0,address memecoin,address quoteToken,address creator,address buybackCreatorRecipient,address protocolFeeRecipient,uint16 creatorTaxBps,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps,bool buybackEnabled)',
]);
export const PONS_V1_ABI=parseAbi([
 'function getLaunchedToken(address token) view returns ((address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount) launch)',
 'function liquidityPool() view returns (address)','function graduationStatus(address token) view returns (uint256 pairedPrincipal,uint256 threshold,bool graduated)',
 'function restrictionEndBlock() view returns (uint256)','function launchBlock() view returns (uint256)',
]);
export const V2_ABI=parseAbi(['function getPair(address a,address b) view returns (address)','function factory() view returns (address)','function token0() view returns (address)','function token1() view returns (address)','function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)']);
export const V3_ABI=parseAbi([
 'function getPool(address a,address b,uint24 fee) view returns (address)','function factory() view returns (address)','function token0() view returns (address)','function token1() view returns (address)','function fee() view returns (uint24)',
 'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)',
 'function liquidity() view returns (uint128)',
 'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
export const V4_ABI=parseAbi([
 'struct Key {address currency0;address currency1;uint24 fee;int24 tickSpacing;address hooks;}',
 'function quoteExactInputSingle((Key poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
 'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
 'function poolManager() view returns (address)',
]);
export const EVENTS=parseAbi([
 'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
 'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)',
 'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)',
 'event PoolGraduated(address indexed token,uint256 positionId,uint256 tokenAmount,uint256 pairTokenAmount)',
 'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
 'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
 'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
 'event Transfer(address indexed from,address indexed to,uint256 value)',
 'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
 'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
 'event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
 'event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
 'event LaunchedToDEX(address token,address pool,uint256 amount,uint256 eth)',
]);
export const V1_LAUNCH=parseAbi(['event TokenLaunched(address indexed token,address indexed deployer,address indexed dexFactory,address pairToken,address pool,uint256 dexId,uint256 launchConfigId,uint256 positionId,uint256 restrictionsEndBlock,uint256 initialBuyAmount)']);
