import { fail } from './database-core.mjs';

export const PAPER_EXECUTION_POLICY = Object.freeze({
  maxBuyPriceImpactPct: 2,
  maxFillSlippageBps: 3000,
});

export function assertEntryQuoteImpact(quote) {
  if (
    !Number.isFinite(quote.priceImpactPct) ||
    quote.priceImpactPct < 0 ||
    (quote.impactQuality !== undefined && !['verified', 'estimated'].includes(quote.impactQuality))
  )
    throw fail('本次买入的价格冲击尚未核实，暂不下单。', 409);
  if (quote.priceImpactPct > PAPER_EXECUTION_POLICY.maxBuyPriceImpactPct)
    throw fail('本次买入的价格冲击超过2%，请调整金额后重新评估。', 409);
}
