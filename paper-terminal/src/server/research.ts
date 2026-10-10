/**
 * Integration contract for main (SQLite/scheduling/API ownership stays in main):
 * 1. Persist EVERY signal attempt and capture immutable ResearchSample snapshots.
 *    entry is the decision-time snapshot; later contains successive head snapshots,
 *    with executable quotes for the EXACT requested USD/raw quantities. Never
 *    interpolate a small order's price to a larger position or fabricate candle fills.
 *    For shared live preparation, supply entryPreparations instead: append each
 *    exact buy/full reverse pair immediately with at===receivedAt===ready time.
 *    Each candidate traverses ENTRY_BUDGETS_USD independently; a smaller ready
 *    pair waits for larger sizes to be excluded. Actual decision time is the
 *    event that makes selection possible, never an earlier buffered pair time.
 *    Keep capturedAt at the initial signal archive time. Persist failed/expired
 *    records, and set last only at the actual close of collection. Stream samples
 *    belong to the signal-receipt window; preparations never carry across windows.
 * 2. cashDebitUsd/cashCreditUsd are FINAL wallet cashflows, including external gas,
 *    approval/conversion charges. feesUsd is attribution ONLY, never deducted twice.
 *    stopEstimates are fee-aware hypothetical liquidation proceeds calculated at
 *    entry using then-known VERIFIED fees; they are NOT future observed stop fills.
 *    quoteNativeCashFlow is the shared canonical ledger helper: native raw units
 *    remain on the account, while USD cost basis is fixed at each execution's FX.
 *    fxTrace covers idle periods; nativeAccounting reports the idle BNB/ETH
 *    benchmark separately from trading P&L. Missing future FX is never inferred.
 *    executionFailurePolicy archives a CONDITIONAL gas model, not a paid cost.
 *    Its paper-slippage-v1 policy is applied only to an executable delayed quote
 *    failing the raw slippage guard. Data/admission/risk rejects never apply it.
 *    failureCost is reserved for explicitly recorded outcomes (incurred=true).
 * 3. source='authoritative' requires archived on-chain/protocol quotes and fees,
 *    receivedAt/capturedAt timestamps and block identifiers. Candles are exploratory.
 *    Append observations by making a NEW frozen snapshot; do not mutate prior rows.
 * 4. Run runResearchInWorker({kind:'train',request}) off the ingestion thread.
 *    It re-seals the forward start at result RECEIPT, after computation completes.
 *    Direct synchronous callers must call freezeResearchWinner(result, Date.now())
 *    before storing a winning result; request.now alone is a simulated clock.
 *    Persist its complete attempts/baselines and frozen version atomically. Capture
 *    seven NEW days from frozen.forwardStart, then run kind:'forward'. Store used
 *    final-test windows durably and supply them to every subsequent training run.
 *    Never promote run.selectedRules until forward returns status='passed'.
 * 5. Shared $100 bankroll, risk gates and conservative valuation are applied here.
 *    Live main must use the same risk settings and frozen version. Unknown assets
 *    are worth zero; failed/unsellable/boundary attempts remain in the result.
 * All timestamps are UTC epoch MILLISECONDS; daily gates reset at Asia/Shanghai
 * midnight. The module has no network, signing or financial execution capability.
 */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Chain, ExitRules, Horizon, Metrics, Quality, Quote, ResearchRun, RiskConfig } from '../shared/domain.js';
import { DEFAULT_RISK } from '../shared/domain.js';
import { nativeUsd, usdNative, usdFloat, usdInt } from './money.js';

export const DAY_MS = 86_400_000;
export const RESEARCH_SEED = 0x474d474e;
export const INITIAL_BANKROLL_USD = 100;
export const NATIVE_ACCOUNTING_POLICY = 'native-ledger-v1' as const;
/** Admission order, not RPC completion order. Main and replay share this ladder. */
export const ENTRY_BUDGETS_USD = [5,3,2,1.5,1,.5,.25] as const;
export type Immutable<T> = T extends readonly (infer E)[] ? readonly Immutable<E>[] : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export interface StopEstimate {
  stopPct: number;
  netProceedsUsd: number;
  quality: 'verified' | 'estimated' | 'unavailable';
  at: number;
}
/** EXACT broker risk recipe: buy spend+outside gas minus current full reverse
 * output scaled by stop AND slippage, minus sell outside gas. Protocol/tax costs
 * already in output are not deducted a second time. Main can use this helper
 * when archiving its stopEstimates; a negative net proceed must NOT be clamped. */
export function feeAwareStopEstimates(buy:Immutable<Quote>,reverse:Immutable<Quote>,stops:readonly number[]=[5,10,15],slippagePct=3,at=Math.max(buy.at,reverse.at)):StopEstimate[] {
  if(buy.side!=='buy'||reverse.side!=='sell'||buy.chain!==reverse.chain||buy.token.toLowerCase()!==reverse.token.toLowerCase()||buy.block!==reverse.block||raw(reverse.inputRaw)!==raw(buy.outputRaw))throw new Error('Stop estimate needs the exact full reverse quote at entry block');
  if(buy.fees.quality==='unavailable'||reverse.fees.quality==='unavailable'||slippagePct<0||slippagePct>100||!finite(slippagePct))throw new Error('Unknown stop fees or slippage');
  const outlay=nativeUsd(buy.spentInputRaw,buy.nativeUsd)+buy.fees.gasUsd+buy.fees.approvalUsd;
  return stops.map(stopPct=>{
    if(!positive(stopPct)||stopPct>=100)throw new Error('Invalid stop percentage');
    const proceeds=nativeUsd(reverse.outputRaw,reverse.nativeUsd)*(1-stopPct/100)*(1-slippagePct/100)-reverse.fees.gasUsd-reverse.fees.approvalUsd;
    const loss=usdFloat(usdInt(Math.max(0,outlay-proceeds)));
    return {stopPct,netProceedsUsd:outlay-loss,quality:buy.fees.quality==='estimated'||reverse.fees.quality==='estimated'?'estimated':'verified',at};
  });
}
export interface FailureCostSnapshot {
  /** Stable ID deduplicates retry/reconnect observations of one failed execution. */
  id:string;at:number;receivedAt:number;cashDebitUsd:number;feesUsd:number;
  quality:Quality;reason:string;
  nativeDebitRaw?:string;nativeUsd?:number;
  /** true only for a captured execution failure outcome. An ordinary quote's
   * hypothetical gas profile is NOT evidence that a missing quote cost money. */
  incurred?:boolean;
}
export interface ExecutionFailurePolicySnapshot extends Omit<FailureCostSnapshot,'incurred'> {
  version:'paper-slippage-v1';
  conditional:'slippageOnly';
}
/** Archive contemporaneous Gas/approval assumptions WITHOUT recording a trade. */
export function createExecutionFailurePolicy(q:Immutable<Quote>,receivedAt=q.at):ExecutionFailurePolicySnapshot {
  if(!finite(receivedAt)||receivedAt<q.at||q.quality==='unavailable'||q.fees.quality==='unavailable'||!positive(q.nativeUsd)
    ||[q.fees.gasUsd,q.fees.approvalUsd].some(n=>!finite(n)||n<0))throw new Error('Execution failure policy needs known contemporaneous gas/FX');
  const amount=usdNative(q.fees.gasUsd+q.fees.approvalUsd,q.nativeUsd,true),cost=nativeUsd(amount,q.nativeUsd);
  return {id:`failure-policy:${q.id}`,at:q.at,receivedAt,cashDebitUsd:cost,feesUsd:cost,quality:q.fees.quality,reason:'Archived gas/approval model applied only when delayed raw slippage fails',nativeDebitRaw:String(amount),nativeUsd:q.nativeUsd,version:'paper-slippage-v1',conditional:'slippageOnly'};
}
export interface NativeFxSnapshot {
  chain:Chain;at:number;receivedAt:number;nativeUsd:number;quality:Quality;source:string;
}
export interface NativeQuoteCashFlow {
  nativeDeltaRaw:string;outsideNativeRaw:string;investmentUsd:number;
  cashDebitUsd:number;cashCreditUsd:number;tradeCashUsd:number;feesUsd:number;
}
/** Shared with Broker: native units are authoritative; only outside gas/approval
 * is charged separately. USD trade cash uses Broker's micro-dollar cost basis. */
export function quoteNativeCashFlow(q:Immutable<Quote>):NativeQuoteCashFlow {
  if(!positive(q.nativeUsd)||[q.fees.gasUsd,q.fees.approvalUsd,q.fees.protocolUsd,q.fees.taxUsd,q.fees.conversionUsd].some(n=>!finite(n)||n<0))throw new Error('Native cash flow needs known FX and fees');
  const outside=q.fees.gasUsd+q.fees.approvalUsd;
  const extra=usdNative(outside,q.nativeUsd,true);
  const delta=q.side==='buy'?-(raw(q.spentInputRaw)+extra):raw(q.outputRaw)-extra;
  return {nativeDeltaRaw:String(delta),outsideNativeRaw:String(extra),investmentUsd:q.side==='buy'?nativeUsd(q.spentInputRaw,q.nativeUsd):0,
    cashDebitUsd:delta<0n?nativeUsd(-delta,q.nativeUsd):0,cashCreditUsd:delta>0n?nativeUsd(delta,q.nativeUsd):0,
    tradeCashUsd:q.side==='buy'?nativeUsd(-delta,q.nativeUsd):usdFloat(usdInt(nativeUsd(q.outputRaw,q.nativeUsd)-outside)),
    feesUsd:outside+q.fees.protocolUsd+q.fees.taxUsd+q.fees.conversionUsd};
}
/** Broker's exact output/spent-input guard, excluding outside gas and USD FX. */
export function quoteSlippageAccepted(reference:Immutable<Quote>,fill:Immutable<Quote>,slippagePct:number):boolean {
  if(reference.side!==fill.side||reference.chain!==fill.chain||reference.token.toLowerCase()!==fill.token.toLowerCase()||!finite(slippagePct)||slippagePct<0||slippagePct>100)return false;
  const qo=raw(fill.outputRaw),qs=raw(fill.spentInputRaw),ro=raw(reference.outputRaw),rs=raw(reference.spentInputRaw);
  if([qo,qs,ro,rs].some(v=>v<=0n))return false;
  return qo*rs*1_000_000n>=ro*qs*BigInt(Math.round((100-slippagePct)*10_000));
}
export interface ExecutableQuoteSnapshot {
  quote: Quote;
  /** Budget requested, not actually spent (partial buys/refunds are supported). */
  requestedUsd?: number;
  requestedTokenRaw?: string;
  tokenAmountRaw: string;
  cashDebitUsd: number;
  cashCreditUsd: number;
  feesUsd: number;
  /** All cashflows already include all costs; false is never formally executable. */
  costsIncluded: boolean;
  executable: boolean;
  failureReason?: string;
  /** Explicit archived simulated execution costs only. A missing quote alone
   * NEVER implies a gas charge or a newly sampled random failure. */
  failureCost?:FailureCostSnapshot;
  executionFailurePolicy?:ExecutionFailurePolicySnapshot;
  receivedAt: number;
  validUntil: number;
  stopEstimates?: StopEstimate[];
  /** Only GAS/approval may be estimated formally. Unknown tax/venue/conversion
   * costs remain blocked. Main archives this contemporaneous assumption. */
  gasAssumption?: {
    at:number;gasUsd:number;approvalUsd:number;method:string;
    nonGasFeesVerified:boolean;executableQuoteVerified:boolean;
  };
}
export interface ResearchObservation {
  at: number;
  receivedAt: number;
  block: number;
  priceUsd: number | null;
  /** Fresh market fallback age; quote prices still take priority for exits. */
  priceAt?:number;
  quotes: ExecutableQuoteSnapshot[];
  /** No synthetic fills across missing blocks; a later actual quote can recover. */
  gap?: boolean;
  removed?: boolean;
}
/** One completed preparation for one signal. Set at/receivedAt to the actual
 * pair-ready time (the same timestamp), never the signal or block timestamp.
 * buy/reverse retain their individual actual receipt times and exact raw sizes.
 * last seals collection at this event; otherwise the source deadline closes it.
 * A failed preparation is evidence of missing data, not a charged execution. */
export interface EntryPreparation {
  at:number;receivedAt:number;block:number;budgetUsd:number;
  status:'ready'|'failed'|'expired';
  buy?:ExecutableQuoteSnapshot;reverse?:ExecutableQuoteSnapshot;
  reason?:string;last?:boolean;
}
export type EntryPreparationSnapshot = Immutable<EntryPreparation>;
export interface ResearchSampleData {
  id: string;
  chain: Chain;
  token: string;
  signalAt: number;
  receivedAt: number;
  decisionAt: number;
  /** When the original entry snapshot was archived, not the last update time. */
  capturedAt: number;
  source: 'authoritative' | 'candles' | 'estimated';
  entry: ResearchObservation;
  /** Present (including []) opts into causal admission; absent preserves legacy
   * entry/decisionAt semantics. capturedAt is the original signal archive time.
   * The sample's decisionAt is a compatibility field; each replay candidate sets
   * its own actual decisionAt from the preparation stream. Default collection
   * deadline is signalExpiresAt when supplied (wallet short 5s / swing 60s),
   * otherwise capturedAt + 15s. The default never shortens a wallet deadline. */
  entryPreparations?:EntryPreparation[];
  later: ResearchObservation[];
  /** Explicit collection coverage, not inferred from the last profitable quote. */
  coveredThrough: number;
  reason: string;
  maxEntryPriceUsd?:number;
  signalExpiresAt?:number;
}
export type ResearchSample = Immutable<ResearchSampleData>;
export type QuoteSnapshot = Immutable<ExecutableQuoteSnapshot>;
export type ObservationSnapshot = Immutable<ResearchObservation>;

export function immutableSnapshot<T>(value: T): Immutable<T> {
  const clone = structuredClone(value);
  const freeze = (v: unknown): void => {
    if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  };
  freeze(clone);
  return clone as Immutable<T>;
}
export function createResearchSample(value: ResearchSampleData | ResearchSample): ResearchSample {
  return immutableSnapshot(value) as ResearchSample;
}
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Non-finite research data'); return JSON.stringify(value); }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b, 'en')).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  throw new Error('Research data must be JSON-compatible');
}
export function researchDataHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

export interface ExitCandidate { id: string; kind: 'grid' | 'baseline'; rules: ExitRules; }
export function exitGrid(horizon: Horizon): ExitCandidate[] {
  const short = horizon === 'short';
  const out: ExitCandidate[] = [];
  for (const stop of short ? [10,15] : [5,10])
    for (const gain of short ? [30,60] : [10,20])
      for (const sell of [50,70])
        for (const trail of short ? [10,20] : [5,10])
          for (const minutes of short ? [5,10] : [30,120]) {
            out.push({id:`${horizon}-s${stop}-g${gain}-q${sell}-t${trail}-m${minutes}`,kind:'grid',rules:{stopPct:stop,targets:[{gainPct:gain,sellOriginalPct:sell}],trailPct:trail,maxHoldMs:minutes*60_000,protectBreakeven:true}});
          }
  return out;
}
export function legacyBaseline(): ExitCandidate {
  return {id:'legacy-losing-baseline',kind:'baseline',rules:{stopPct:15,targets:[{gainPct:50,sellOriginalPct:60},{gainPct:100,sellOriginalPct:25},{gainPct:200,sellOriginalPct:15}],trailPct:20,maxHoldMs:600_000,protectBreakeven:true}};
}

export interface ReplayFill {
  side: 'buy' | 'sell'; at: number; block: number; quoteId: string;
  tokenRaw: string; cashDebitUsd: number; cashCreditUsd: number; feesUsd: number;
  reason: string; targets: number[];
  nativeDeltaRaw:string;nativeUsd:number;
}
export interface ReplayAttempt {
  sampleId: string; token: string; status: 'skipped' | 'failed' | 'open' | 'closed' | 'purged';
  reason: string; decisionAt: number; openedAt: number | null; endedAt: number | null;
  originalRaw: string; remainingRaw: string; outlayUsd: number; cashBackUsd: number;
  feesUsd: number; netUsd: number; conservativeValueUsd: number;
  missing: boolean; fills: ReplayFill[]; failures: {at:number;reason:string;cashDebitUsd?:number;feesUsd?:number;quoteId?:string}[];
  preparations?:{at:number;receivedAt:number;block:number;budgetUsd:number;status:EntryPreparation['status'];reason:string;disposition:'waiting'|'rejected'|'selected'|'unused'}[];
}
export interface ReplayResult {
  metrics: Metrics; attempts: ReplayAttempt[]; equity: {at:number;cashUsd:number;reservedUsd:number;equityUsd:number;nativeBalanceRaw:string|null;reservedNativeRaw:string;nativeUsd:number|null;idleBenchmarkUsd:number}[];
  dataHash: string; authoritative: boolean; issues: string[]; from: number; to: number;
  nativeAccounting:{policy:typeof NATIVE_ACCOUNTING_POLICY;fundedAt:number|null;initialFx:number|null;finalFx:number|null;initialNativeRaw:string|null;finalNativeRaw:string|null;reservedNativeRaw:string;cashUsd:number;realizedTradingUsd:number;conservativeTradingUsd:number;unrealizedTradingUsd:number;nativeCashFxUsd:number;idleBenchmarkEquityUsd:number;idleBenchmarkNetUsd:number;excessOverIdleUsd:number;fxTraceHash:string};
}
export interface ReplayOptions {
  from: number; to: number; chain?: Chain;
  initialCapitalUsd?: number; risk?: Immutable<RiskConfig>; latencyMs?: number; slippagePct?: number;
  maxQuoteAgeMs?: number;
  /** Full point-in-time market FX trace includes idle periods; quotes supplement
   * it. Last observed FX is carried causally; never interpolate future rates. */
  fxTrace?:readonly Immutable<NativeFxSnapshot>[];
}
interface PendingExit { reason: string; targets: number[]; raw: bigint; dueAt: number; afterBlock: number; reference: QuoteSnapshot | null; }
interface LivePosition {
  sample: ResearchSample; attempt: ReplayAttempt; referenceBuy: QuoteSnapshot;
  dueAt: number; afterBlock: number; budget: number; raw: bigint; original: bigint;
  decimals: number; entryPrice: number; peak: number; done: Set<number>;
  remainingCostUsd:number;
  reservedNative:bigint;
  pending: PendingExit | null; lastObservation: ObservationSnapshot | null;
  /** Stream buy reference must still be fresh before delayed execution. */
  preparationReference?:ObservationSnapshot;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
function raw(v: string | undefined): bigint { if(!v||!/^\d{1,78}$/.test(v))return 0n;const n=BigInt(v);return n<(1n<<256n)?n:0n; }
function day(at: number): string { return new Date(at + 8*3_600_000).toISOString().slice(0,10); }
function units(q: bigint, decimals: number): number { return Number(q) / 10**decimals; }
function validRules(r: Immutable<ExitRules>): boolean {
  return positive(r.stopPct) && r.stopPct < 100 && finite(r.trailPct) && r.trailPct >= 0 && r.trailPct < 100 && positive(r.maxHoldMs)
    && r.targets.every(t=>positive(t.gainPct)&&positive(t.sellOriginalPct)&&t.sellOriginalPct<=100)
    && r.targets.reduce((n,t)=>n+t.sellOriginalPct,0)<=100+1e-10;
}
function validRisk(r: RiskConfig): boolean {
  return positive(r.riskPct)&&r.riskPct<=.5 && positive(r.maxPositionPct)&&r.maxPositionPct<=5 && Number.isInteger(r.maxPositions)&&r.maxPositions>0&&r.maxPositions<=3
    && Number.isInteger(r.dailyEntries)&&r.dailyEntries>0&&r.dailyEntries<=10 && Number.isInteger(r.maxConsecutiveLosses)&&r.maxConsecutiveLosses>0&&r.maxConsecutiveLosses<=3 && positive(r.dailyLossPct)&&r.dailyLossPct<=1.5;
}
function gasAssumptionValid(q:QuoteSnapshot,at:number):boolean {
  const a=q.gasAssumption;
  return !!a&&finite(a.at)&&a.at<=q.quote.at&&a.at<=at&&a.nonGasFeesVerified&&a.executableQuoteVerified&&a.method.trim().length>0
    &&a.gasUsd===q.quote.fees.gasUsd&&a.approvalUsd===q.quote.fees.approvalUsd;
}
function feeValid(q:QuoteSnapshot,at:number): boolean {
  const f=q.quote.fees;
  return (f.quality==='verified'||f.quality==='estimated'&&gasAssumptionValid(q,at)) && [f.gasUsd,f.approvalUsd,f.protocolUsd,f.taxUsd,f.conversionUsd].every(n=>finite(n)&&n>=0);
}
function quoteValid(q: QuoteSnapshot, p: ObservationSnapshot, sample: ResearchSample, at: number, maxAge: number): boolean {
  const v=q.quote;
  return q.executable && q.costsIncluded && sample.source==='authoritative' && (v.quality==='verified'||v.quality==='estimated'&&gasAssumptionValid(q,at)) && feeValid(q,at)
    && v.chain===sample.chain && v.token.toLowerCase()===sample.token.toLowerCase() && v.block===p.block && v.at<=p.at
    && q.receivedAt<=at && q.receivedAt>=v.at && v.at<=at && at-v.at<=maxAge && q.validUntil>=at
    && positive(v.priceUsd)&&positive(v.nativeUsd) && Number.isInteger(v.tokenDecimals)&&v.tokenDecimals>=0&&v.tokenDecimals<=36
    && [q.cashDebitUsd,q.cashCreditUsd,q.feesUsd].every(n=>finite(n)&&n>=0) && raw(q.tokenAmountRaw)>0n;
}
function buyAt(p: ObservationSnapshot, sample: ResearchSample, at: number, requested: number, maxAge: number): QuoteSnapshot | undefined {
  return p.quotes.find(q=>q.quote.side==='buy'&&finite(q.requestedUsd)&&Math.abs(q.requestedUsd-requested)<1e-9 && quoteValid(q,p,sample,at,maxAge)
    && q.cashDebitUsd>0&&q.cashCreditUsd===0&&raw(q.quote.inputRaw)>0n&&raw(q.quote.spentInputRaw)>0n&&raw(q.tokenAmountRaw)===raw(q.quote.outputRaw));
}
function sellAt(p: ObservationSnapshot, sample: ResearchSample, at: number, requested: bigint, maxAge: number): QuoteSnapshot | undefined {
  return p.quotes.find(q=>q.quote.side==='sell'&&raw(q.requestedTokenRaw)===requested&&raw(q.quote.inputRaw)===requested&&raw(q.tokenAmountRaw)<=requested
    &&raw(q.quote.spentInputRaw)===raw(q.tokenAmountRaw)&&quoteValid(q,p,sample,at,maxAge));
}
function stopRisk(q: QuoteSnapshot, stop: number, at: number): number | null {
  const e=q.stopEstimates?.find(v=>Math.abs(v.stopPct-stop)<1e-10&&(v.quality==='verified'||v.quality==='estimated'&&gasAssumptionValid(q,at))&&v.at<=at&&finite(v.netProceedsUsd));
  return e ? usdFloat(usdInt(Math.max(0,nativeUsd(q.quote.spentInputRaw,q.quote.nativeUsd)+q.quote.fees.gasUsd+q.quote.fees.approvalUsd-e.netProceedsUsd))) : null;
}
function clippedFx(trace:readonly Immutable<NativeFxSnapshot>[],from:number,to:number,chain?:Chain):Immutable<NativeFxSnapshot>[] {
  const sorted=trace.filter(f=>(!chain||f.chain===chain)&&f.quality==='verified'&&positive(f.nativeUsd)&&finite(f.receivedAt)&&f.at<=f.receivedAt&&f.receivedAt<=to)
    .sort((a,b)=>a.receivedAt-b.receivedAt||a.at-b.at||a.source.localeCompare(b.source,'en'));
  const before=sorted.filter(f=>f.receivedAt<from).at(-1);
  return [...(before?[before]:[]),...sorted.filter(f=>f.receivedAt>=from)];
}
function clippedSamples(samples: readonly ResearchSample[], from: number, to: number): ResearchSample[] {
  const start=(s:ResearchSample)=>s.entryPreparations===undefined?s.decisionAt:s.capturedAt;
  return samples.filter(s=>start(s)>=from&&start(s)<to).map(s=>createResearchSample({...s,
    ...(s.entryPreparations===undefined?{}:{decisionAt:s.capturedAt,entryPreparations:s.entryPreparations.filter(p=>p.at<to&&p.receivedAt<to)}),
    coveredThrough:Math.min(s.coveredThrough,to),later:s.later.filter(p=>p.receivedAt<to&&p.at<to)}))
    .sort((a,b)=>start(a)-start(b)||a.id.localeCompare(b.id,'en'));
}

/** Chronological portfolio replay. Every accepted position consumes shared cash. */
export function replayPortfolio(input: readonly ResearchSample[], rules: Immutable<ExitRules>, options: ReplayOptions): ReplayResult {
  if (!validRules(rules)) throw new Error('Invalid exit rules');
  const risk={...DEFAULT_RISK,...options.risk};
  if (!validRisk(risk)) throw new Error('Research risk limits may be tightened, never relaxed');
  const initial=options.initialCapitalUsd??INITIAL_BANKROLL_USD;
  if (!positive(initial)||!finite(options.from)||!finite(options.to)||options.to<=options.from) throw new Error('Invalid replay window/capital');
  const latency=options.latencyMs??500, slippage=options.slippagePct??3, maxAge=options.maxQuoteAgeMs??5_000;
  if (!finite(latency)||latency<500||!finite(slippage)||slippage<0||slippage>100||!positive(maxAge)) throw new Error('Invalid execution policy');
  const samples=clippedSamples(input,options.from,options.to);
  const attempts:ReplayAttempt[]=[], issues:string[]=[];
  const active=new Map<string,LivePosition>();
  const chargedFailures=new Set<string>();
  let cash=initial,reserved=0,currentDay='',dayStart=initial,dayEntries=0,dayNetUsd=0,losses=0,halt='';
  // The nullable balance is initialized by chronological FX callbacks below.
  let nativeBalance=null as bigint|null,reservedNative=0n,initialNative:bigint|null=null,fx:number|null=null,initialFx:number|null=null,fundedAt:number|null=null;
  const refreshCash=()=>{cash=nativeBalance===null||fx===null?initial:nativeUsd(nativeBalance,fx);reserved=fx===null?0:nativeUsd(reservedNative,fx);};
  const idleBenchmark=()=>initialNative===null||fx===null?initial:nativeUsd(initialNative,fx);
  const updateFx=(f:Immutable<NativeFxSnapshot>,at:number)=>{fx=f.nativeUsd;if(nativeBalance===null){nativeBalance=usdNative(initial,fx);initialNative=nativeBalance;initialFx=fx;fundedAt=at;}refreshCash();};
  const curve:ReplayResult['equity']=[];
  let high=initial,maxDD=0;
  const mark=(pos:LivePosition,at:number):number=>{
    if(pos.raw===0n||!pos.lastObservation)return 0;
    const p=pos.lastObservation;
    if(p.gap||p.removed||at-p.receivedAt>maxAge)return 0;
    const q=sellAt(p,pos.sample,at,pos.raw,maxAge);
    return q?Math.max(0,quoteNativeCashFlow(q.quote).tradeCashUsd):0;
  };
  const equity=(at:number):number=>cash+[...active.values()].reduce((n,p)=>n+mark(p,at),0);
  const unknownInventory=(at:number):boolean=>[...active.values()].some(pos=>pos.raw>0n&&(!pos.lastObservation||pos.lastObservation.gap||pos.lastObservation.removed||!sellAt(pos.lastObservation,pos.sample,at,pos.raw,maxAge)));
  const record=(at:number):void=>{
    const e=equity(at);high=Math.max(high,e);maxDD=Math.max(maxDD,high>0?(high-e)/high*100:100);
    curve.push({at,cashUsd:cash,reservedUsd:reserved,equityUsd:e,nativeBalanceRaw:nativeBalance===null?null:String(nativeBalance),reservedNativeRaw:String(reservedNative),nativeUsd:fx,idleBenchmarkUsd:idleBenchmark()});
    if(currentDay&&(dayNetUsd<=-dayStart*risk.dailyLossPct/100+1e-10||!unknownInventory(at)&&e<=dayStart*(1-risk.dailyLossPct/100)+1e-10))halt='daily net loss limit';
  };
  const resetDay=(at:number):void=>{const d=day(at);if(d!==currentDay){currentDay=d;dayStart=equity(at);dayEntries=0;dayNetUsd=0;losses=0;halt='';}};
  const close=(p:LivePosition,at:number):void=>{
    const a=p.attempt;a.status='closed';a.endedAt=at;a.remainingRaw='0';a.netUsd=a.cashBackUsd-a.outlayUsd;a.conservativeValueUsd=0;
    losses=a.netUsd< -1e-10?losses+1:0;if(losses>=risk.maxConsecutiveLosses)halt='consecutive loss limit';
    active.delete(p.sample.id);
  };
  const failure=(p:LivePosition,at:number,reason:string,missing:boolean):void=>{
    p.attempt.failures.push({at,reason});p.attempt.reason=reason;p.attempt.missing ||=missing;
    if(missing)issues.push(`${p.sample.id}: ${reason}`);
  };
  const chargeFailure=(pos:Pick<LivePosition,'attempt'|'sample'>,p:ObservationSnapshot,at:number,side:'buy'|'sell',requested:number|bigint,trigger:'observed'|'slippage',quoted?:QuoteSnapshot):boolean=>{
    const archived=quoted??p.quotes.find(q=>q.quote.side===side&&(side==='buy'?q.requestedUsd===requested:raw(q.requestedTokenRaw)===requested)&&q.failureCost?.incurred===true);
    if(!archived)return false;
    const actual=archived.failureCost?.incurred===true?archived.failureCost:undefined;
    const policy=trigger==='slippage'&&quoted?archived.executionFailurePolicy:undefined;
    const f=actual??policy;
    if(!f||f.at>at||f.receivedAt>at||!finite(f.cashDebitUsd)||f.cashDebitUsd<0||!finite(f.feesUsd)||f.feesUsd<0)return false;
    if(!actual){
      if(!policy||policy.version!=='paper-slippage-v1'||policy.conditional!=='slippageOnly')return false;
      // Policies cannot silently underprice a failure, include pool/tax fees, or
      // substitute later FX. This is Broker.fail(q, chargeGas=true)'s exact cost.
      const expected=usdNative(archived.quote.fees.gasUsd+archived.quote.fees.approvalUsd,archived.quote.nativeUsd,true);
      const modelFx=policy.nativeUsd??archived.quote.nativeUsd;
      if(!positive(modelFx)||policy.at<archived.quote.at||policy.receivedAt<policy.at)return false;
      const modelRaw=policy.nativeDebitRaw===undefined?usdNative(policy.cashDebitUsd,modelFx,true):raw(policy.nativeDebitRaw);
      const expectedUsd=nativeUsd(expected,archived.quote.nativeUsd);
      if(modelFx!==archived.quote.nativeUsd||modelRaw!==expected||Math.abs(policy.cashDebitUsd-expectedUsd)>1e-6||Math.abs(policy.feesUsd-expectedUsd)>1e-6)return false;
    }
    const known=f.quality==='verified'||f.quality==='estimated'&&gasAssumptionValid(archived!,at);
    if(chargedFailures.has(f.id))return known;
    chargedFailures.add(f.id);
    const failureFx=f.nativeUsd??archived!.quote.nativeUsd;
    if(!positive(failureFx)||nativeBalance===null)return false;
    const wanted=f.nativeDebitRaw===undefined?usdNative(f.cashDebitUsd,failureFx,true):raw(f.nativeDebitRaw);
    if(wanted>nativeBalance-reservedNative){
      pos.attempt.failures.push({at,reason:'insufficient unreserved native cash; no simulated broadcast or gas debit',cashDebitUsd:0,feesUsd:0,quoteId:archived!.quote.id});
      return known;
    }
    const charged=wanted;
    const cost=nativeUsd(charged,failureFx);
    nativeBalance-=charged;refreshCash();
    dayNetUsd=usdFloat(usdInt(dayNetUsd)-usdInt(cost));
    // Buy failure fees are outlay without inventory. Failed sells reduce cash back.
    if(side==='buy')pos.attempt.outlayUsd+=cost;else pos.attempt.cashBackUsd-=cost;
    const fees=f.cashDebitUsd>0?usdFloat(usdInt(f.feesUsd*cost/f.cashDebitUsd)):0;pos.attempt.feesUsd+=fees;
    pos.attempt.failures.push({at,reason:f.reason,cashDebitUsd:cost,feesUsd:fees,quoteId:archived!.quote.id});
    if(!known){pos.attempt.missing=true;issues.push(`${pos.sample.id}: failure cost evidence uncertain`);}
    return known;
  };
  const protectsCost=(pos:LivePosition,p:ObservationSnapshot,at:number):boolean=>{
    if(!rules.protectBreakeven||pos.raw>=pos.original)return false;
    const q=sellAt(p,pos.sample,at,pos.raw,maxAge);
    return !!q&&quoteNativeCashFlow(q.quote).tradeCashUsd<=pos.remainingCostUsd+1e-10;
  };
  const exitPrice=(pos:LivePosition,p:ObservationSnapshot,at:number):number|null=>{
    const whole=sellAt(p,pos.sample,at,pos.raw,maxAge);
    if(whole)return whole.quote.priceUsd;
    const marketAt=p.priceAt??p.at;
    return positive(p.priceUsd)&&marketAt<=at&&at-marketAt<=maxAge?p.priceUsd:null;
  };
  const targetQuantity=(original:bigint,index:number):bigint=>{
    const before=rules.targets.slice(0,index).reduce((n,t)=>n+t.sellOriginalPct,0);
    const through=before+rules.targets[index].sellOriginalPct;
    const scaled=(pct:number)=>original*BigInt(Math.round(Math.min(100,pct)*10_000))/1_000_000n;
    return scaled(through)-scaled(before);
  };
  type TapeEvent={at:number;kind:'decision'|'observation'|'preparationStart'|'preparation'|'preparationEnd';sample:ResearchSample;p:ObservationSnapshot;ordinal:number;preparation?:EntryPreparationSnapshot;index?:number};
  type FxEvent={at:number;kind:'fx';fx:Immutable<NativeFxSnapshot>;ordinal:number};
  const events:(TapeEvent|FxEvent)[]=[];
  const fxData:Immutable<NativeFxSnapshot>[]=clippedFx(options.fxTrace??[],options.from,options.to,options.chain);
  const chains=new Set(samples.map(s=>s.chain));
  if(!options.chain&&chains.size>1)throw new Error('A native bankroll must belong to ONE chain');
  samples.forEach((s,i)=>{
    if(s.entryPreparations===undefined)events.push({at:s.decisionAt,kind:'decision',sample:s,p:s.entry,ordinal:i});
    else{
      events.push({at:s.capturedAt,kind:'preparationStart',sample:s,p:s.entry,ordinal:i});
      for(const [index,preparation] of s.entryPreparations.entries()){
        const at=Math.max(preparation.at,preparation.receivedAt);
        events.push({at:finite(at)?Math.max(s.capturedAt,at):s.capturedAt,kind:'preparation',sample:s,p:s.entry,ordinal:i,preparation,index});
      }
      const deadline=s.signalExpiresAt??s.capturedAt+15_000;
      events.push({at:Math.max(s.capturedAt,deadline),kind:'preparationEnd',sample:s,p:s.entry,ordinal:i});
    }
    s.later.forEach(p=>events.push({at:p.receivedAt,kind:'observation',sample:s,p,ordinal:i}));
    const preparationPoints=(s.entryPreparations??[]).map(p=>({at:p.at,receivedAt:p.receivedAt,block:p.block,priceUsd:p.buy?.quote.priceUsd??null,quotes:[...(p.buy?[p.buy]:[]),...(p.reverse?[p.reverse]:[])]}));
    if(s.source==='authoritative'&&(!options.chain||s.chain===options.chain))for(const p of [...(s.entryPreparations===undefined?[s.entry]:[]),...preparationPoints,...s.later])if(!('removed' in p&&p.removed)&&!('gap' in p&&p.gap))for(const q of p.quotes){
      if(q.receivedAt<=p.receivedAt&&q.quote.at<=q.receivedAt&&positive(q.quote.nativeUsd)&&(q.quote.quality==='verified'||gasAssumptionValid(q,q.receivedAt)))fxData.push({chain:s.chain,at:q.quote.at,receivedAt:q.receivedAt,nativeUsd:q.quote.nativeUsd,quality:'verified',source:`quote:${q.quote.id}`});
    }
  });
  const fxSeries=clippedFx(fxData,options.from,options.to,options.chain).filter((f,i,a)=>i===0||f.receivedAt!==a[i-1].receivedAt||f.nativeUsd!==a[i-1].nativeUsd);
  fxSeries.forEach((f,i)=>events.push({at:Math.max(options.from,f.receivedAt),kind:'fx',fx:f,ordinal:i}));
  const priority={fx:0,preparationStart:1,observation:2,decision:3,preparation:3,preparationEnd:4};
  events.sort((a,b)=>a.at-b.at||priority[a.kind]-priority[b.kind]||a.ordinal-b.ordinal||(a.kind!=='fx'&&b.kind!=='fx'?(a.index??0)-(b.index??0)||a.p.block-b.p.block:0));
  const seen=new Set<string>();
  const makeAttempt=(s:ResearchSample,at:number):ReplayAttempt=>({sampleId:s.id,token:s.token,status:'skipped',reason:'',decisionAt:at,openedAt:null,endedAt:null,originalRaw:'0',remainingRaw:'0',outlayUsd:0,cashBackUsd:0,feesUsd:0,netUsd:0,conservativeValueUsd:0,missing:false,fills:[],failures:[]});
  type PreparationDetail=NonNullable<ReplayAttempt['preparations']>[number];
  type PreparationState={sample:ResearchSample;attempt:ReplayAttempt;ordinal:number;next:number;settled:boolean;sealed:boolean;ready:Map<number,{preparation:EntryPreparationSnapshot;detail:PreparationDetail}>};
  const preparing=new Map<string,PreparationState>();
  const prepMissing=(state:PreparationState,at:number,reason:string)=>{
    state.attempt.missing=true;state.attempt.failures.push({at,reason});issues.push(`${state.sample.id}: ${reason}`);
  };
  const finishPreparation=(state:PreparationState,at:number,reason:string)=>{
    state.settled=true;state.attempt.decisionAt=at;state.attempt.endedAt=at;state.attempt.reason=reason;
    state.attempt.netUsd=state.attempt.cashBackUsd-state.attempt.outlayUsd;
    if(state.attempt.outlayUsd>0)state.attempt.status='failed';
  };
  const preparationObservation=(prep:EntryPreparationSnapshot,at:number):ObservationSnapshot=>({at,receivedAt:at,block:prep.block,priceUsd:prep.buy?.quote.priceUsd??null,quotes:[...(prep.buy?[prep.buy]:[]),...(prep.reverse?[prep.reverse]:[])]});
  const preparationPair=(prep:EntryPreparationSnapshot,s:ResearchSample,at:number)=>{
    const p=preparationObservation(prep,at),age=Math.min(maxAge,5_000);
    const buy=buyAt(p,s,at,prep.budgetUsd,age),reverse=buy?sellAt(p,s,at,raw(buy.quote.outputRaw),age):undefined;
    if(!buy||!reverse||!finite(buy.quote.priceImpactPct)||!buy.quote.fees.includedInOutput||!reverse.quote.fees.includedInOutput
      ||raw(buy.quote.spentInputRaw)>raw(buy.quote.inputRaw)||raw(buy.quote.refundRaw)!==raw(buy.quote.inputRaw)-raw(buy.quote.spentInputRaw)
      ||raw(reverse.quote.spentInputRaw)!==raw(buy.quote.outputRaw)||reverse.quote.refundRaw!=='0')return null;
    return {p,buy,reverse};
  };
  const tryPreparations=(state:PreparationState,at:number)=>{
    if(state.settled)return;
    const s=state.sample,a=state.attempt,deadline=s.signalExpiresAt??s.capturedAt+15_000;
    if(at>=deadline){finishPreparation(state,at,s.signalExpiresAt!==undefined&&deadline===s.signalExpiresAt?'wallet signal expired':'entry preparation expired');return;}
    while(state.next<ENTRY_BUDGETS_USD.length){
      const budget=ENTRY_BUDGETS_USD[state.next],available=state.ready.get(budget);
      if(!available){if(state.sealed){prepMissing(state,at,'larger size preparation missing when stream sealed');finishPreparation(state,at,'verified size preparation missing');}return;}
      const {preparation:prep,detail}=available;
      detail.disposition='rejected';
      if(prep.status==='expired'){detail.reason=prep.reason??'entry preparation expired';finishPreparation(state,at,detail.reason);return;}
      if(prep.status==='failed'){detail.reason=prep.reason??'entry preparation quote failed';state.next++;continue;}
      const pair=preparationPair(prep,s,at);
      if(!pair){
        detail.reason='exact pair, verified fees or fresh reference missing';prepMissing(state,at,detail.reason);finishPreparation(state,at,detail.reason);return;
      }
      const {p,buy,reverse}=pair;
      const fail=(reason:string)=>{detail.reason=reason;finishPreparation(state,at,reason);};
      if(s.maxEntryPriceUsd!==undefined&&(!positive(s.maxEntryPriceUsd)||buy.quote.priceUsd>s.maxEntryPriceUsd+1e-12)){fail('wallet entry price exceeds premium cap');return;}
      record(at);
      const e=equity(at),queued=[...active.values()].filter(v=>v.attempt.openedAt===null).length;
      if(halt){fail(halt);return;}
      if(e<=dayStart*(1-risk.dailyLossPct/100)+1e-10){fail('daily net loss limit');return;}
      if(dayEntries+queued>=risk.dailyEntries){fail('daily entry limit');return;}
      if(active.size>=risk.maxPositions){fail('maximum simultaneous positions');return;}
      if([...active.values()].some(v=>v.sample.chain===s.chain&&v.sample.token.toLowerCase()===s.token.toLowerCase())){fail('position already open; no add');return;}
      // Recompute for this candidate from the exact pair. An archived estimate
      // for another stop/assumption cannot influence sizing or admission.
      const estimates=feeAwareStopEstimates(buy.quote,reverse.quote,[rules.stopPct],slippage,at);
      const reference=immutableSnapshot({...buy,stopEstimates:estimates});
      const referencePoint=immutableSnapshot({...p,quotes:[reference,reverse]});
      const spend=nativeUsd(buy.quote.spentInputRaw,buy.quote.nativeUsd)+buy.quote.fees.gasUsd+buy.quote.fees.approvalUsd;
      const planned=usdFloat(usdInt(Math.max(0,spend-estimates[0].netProceedsUsd)));
      if(spend>e*risk.maxPositionPct/100+1e-6||planned>e*risk.riskPct/100+1e-6){detail.reason='fees/risk budget rejects size';state.next++;continue;}
      if(buy.quote.priceImpactPct>2){fail('price impact exceeds admission limit');return;}
      const held=raw(buy.quote.inputRaw)+usdNative((buy.quote.fees.gasUsd+buy.quote.fees.approvalUsd)*1.5,buy.quote.nativeUsd,true);
      if(nativeBalance===null||held>nativeBalance-reservedNative){fail('insufficient unreserved native cash');return;}
      reservedNative+=held;refreshCash();state.settled=true;detail.disposition='selected';detail.reason='first eligible size';
      for(const entry of state.ready.values())if(entry.detail.disposition==='waiting'){entry.detail.disposition='unused';entry.detail.reason='earlier eligible size selected';}
      a.status='open';a.reason='buy queued';a.decisionAt=at;a.endedAt=null;
      active.set(s.id,{sample:s,attempt:a,referenceBuy:reference,dueAt:at+latency,afterBlock:prep.block,budget,raw:0n,original:0n,decimals:buy.quote.tokenDecimals,entryPrice:0,peak:0,done:new Set(),remainingCostUsd:0,reservedNative:held,pending:null,lastObservation:null,preparationReference:referencePoint});
      record(at);return;
    }
    finishPreparation(state,at,'fees/risk budget has no affordable exact quote');
  };
  record(options.from);
  for(const event of events){
    const {at}=event;
    if(at<options.from||at>options.to||event.kind!=='fx'&&at===options.to)continue;
    if(event.kind==='fx'){updateFx(event.fx,at);resetDay(at);record(at);continue;}
    resetDay(at);
    const {sample:s}=event;let p=event.p;
    if(event.kind==='preparationStart'){
      if(seen.has(s.id)){const prior=preparing.get(s.id);if(prior)prepMissing(prior,at,'duplicate sample id');continue;}seen.add(s.id);
      const a=makeAttempt(s,at);a.reason='waiting for causal size preparation';a.preparations=[];attempts.push(a);
      const state:PreparationState={sample:s,attempt:a,ordinal:event.ordinal,next:0,settled:false,sealed:false,ready:new Map()};preparing.set(s.id,state);
      if(options.chain&&s.chain!==options.chain)finishPreparation(state,at,'different chain');
      else if(s.source!=='authoritative'||s.signalAt>at||s.receivedAt>at){prepMissing(state,at,'signal missing or exploratory at preparation start');finishPreparation(state,at,'signal missing or unavailable');}
      continue;
    }
    if(event.kind==='preparation'||event.kind==='preparationEnd'){
      const state=preparing.get(s.id);if(!state||state.ordinal!==event.ordinal)continue;
      if(event.kind==='preparationEnd'){if(!state.settled)finishPreparation(state,at,s.signalExpiresAt!==undefined&&at>=s.signalExpiresAt?'wallet signal expired':'entry preparation expired');record(at);continue;}
      const prep=event.preparation!,detail:PreparationDetail={at:prep.at,receivedAt:prep.receivedAt,block:prep.block,budgetUsd:prep.budgetUsd,status:prep.status,reason:prep.reason??'',disposition:state.settled?'unused':'waiting'};
      state.attempt.preparations!.push(detail);
      if(!finite(prep.at)||!finite(prep.receivedAt)||prep.at!==prep.receivedAt||prep.at<at||prep.at<s.capturedAt||!Number.isInteger(prep.block)||prep.block<0||!ENTRY_BUDGETS_USD.some(b=>b===prep.budgetUsd)||!['ready','failed','expired'].includes(prep.status)){
        detail.disposition='rejected';detail.reason='invalid or backdated preparation';prepMissing(state,at,detail.reason);if(!state.settled)finishPreparation(state,at,detail.reason);continue;
      }
      if(prep.status==='failed'){
        prepMissing(state,at,prep.reason??'entry preparation quote failed');
        if(!state.settled&&prep.buy?.failureCost?.incurred===true&&prep.buy.quote.side==='buy'&&prep.buy.quote.chain===s.chain&&prep.buy.quote.token.toLowerCase()===s.token.toLowerCase()&&prep.buy.receivedAt<=at&&prep.buy.quote.at<=at){
          chargeFailure({sample:s,attempt:state.attempt},preparationObservation(prep,at),at,'buy',prep.budgetUsd,'observed',prep.buy);detail.disposition='rejected';finishPreparation(state,at,prep.reason??'recorded failed execution');record(at);continue;
        }
      }
      if(prep.status==='ready'&&!preparationPair(prep,s,at)){
        detail.disposition='rejected';detail.reason='exact pair, verified fees or fresh reference missing';prepMissing(state,at,detail.reason);if(!state.settled)finishPreparation(state,at,detail.reason);continue;
      }
      if(state.ready.has(prep.budgetUsd)){detail.disposition='unused';detail.reason='duplicate size preparation';prepMissing(state,at,detail.reason);continue;}
      state.ready.set(prep.budgetUsd,{preparation:prep,detail});
      if(prep.last)state.sealed=true;
      if(prep.status==='expired'&&!state.settled){detail.disposition='rejected';finishPreparation(state,at,prep.reason??'entry preparation expired');}
      else tryPreparations(state,at);
      continue;
    }
    if(event.kind==='decision'){
      const a=makeAttempt(s,at);
      attempts.push(a);
      const skip=(reason:string,missing=false)=>{a.reason=reason;a.missing=missing;if(missing)issues.push(`${s.id}: ${reason}`);};
      if(seen.has(s.id)){skip('duplicate sample id',true);continue;}seen.add(s.id);
      if(options.chain&&s.chain!==options.chain){skip('different chain');continue;}
      if(s.source!=='authoritative'){skip('exploratory data cannot produce formal fills',true);continue;}
      if(s.signalAt>at||s.receivedAt>at||s.capturedAt>at||s.capturedAt<p.at||p.receivedAt>at||p.at>at||p.gap||p.removed||!positive(p.priceUsd)){skip('entry missing or unavailable at decision',true);continue;}
      if(s.signalExpiresAt!==undefined&&(!finite(s.signalExpiresAt)||at>s.signalExpiresAt)){skip('wallet signal expired');continue;}
      if(s.maxEntryPriceUsd!==undefined&&!positive(s.maxEntryPriceUsd)){skip('wallet price cap invalid',true);continue;}
      record(at); // Expired valuations must trigger the daily halt BEFORE admission.
      const e=equity(at);
      if(halt){skip(halt);continue;}
      if(e<=dayStart*(1-risk.dailyLossPct/100)+1e-10){skip('daily net loss limit');continue;}
      const queuedEntries=[...active.values()].filter(v=>v.attempt.openedAt===null).length;
      if(dayEntries+queuedEntries>=risk.dailyEntries){skip('daily entry limit');continue;}
      if(active.size>=risk.maxPositions){skip('maximum simultaneous positions');continue;}
      if([...active.values()].some(v=>v.sample.chain===s.chain&&v.sample.token.toLowerCase()===s.token.toLowerCase())){skip('position already open; no add');continue;}
      const cap=e*risk.maxPositionPct/100;
      const reserveFor=(q:QuoteSnapshot)=>raw(q.quote.inputRaw)+usdNative((q.quote.fees.gasUsd+q.quote.fees.approvalUsd)*1.5,q.quote.nativeUsd,true);
      const quotes=p.quotes.filter(q=>q.quote.side==='buy'&&positive(q.requestedUsd)&&buyAt(p,s,at,q.requestedUsd,maxAge)===q
        &&nativeUsd(q.quote.spentInputRaw,q.quote.nativeUsd)+q.quote.fees.gasUsd+q.quote.fees.approvalUsd<=cap+1e-6
        &&q.quote.priceImpactPct<=2&&nativeBalance!==null&&reserveFor(q)<=nativeBalance-reservedNative
        &&(s.maxEntryPriceUsd===undefined||q.quote.priceUsd<=s.maxEntryPriceUsd+1e-12)
        &&stopRisk(q,rules.stopPct,p.at)!==null&&(stopRisk(q,rules.stopPct,p.at) as number)<=e*risk.riskPct/100+1e-10)
        .sort((a,b)=>(b.requestedUsd as number)-(a.requestedUsd as number)||a.quote.id.localeCompare(b.quote.id,'en'));
      const q=quotes[0];
      if(!q){
        const hasVerified=p.quotes.some(q=>q.quote.side==='buy'&&finite(q.requestedUsd)&&buyAt(p,s,at,q.requestedUsd,maxAge)&&stopRisk(q,rules.stopPct,p.at)!==null);
        const premiumBlocked=s.maxEntryPriceUsd!==undefined&&p.quotes.some(q=>q.quote.side==='buy'&&q.quote.priceUsd>s.maxEntryPriceUsd!);
        skip(premiumBlocked?'wallet entry price exceeds premium cap':hasVerified?'fees/risk budget has no affordable exact quote':'verified size quotes or fee-aware stop estimates missing',!hasVerified);continue;
      }
      const budget=q.requestedUsd as number,held=reserveFor(q);reservedNative+=held;refreshCash();
      a.status='open';a.reason='buy queued';
      active.set(s.id,{sample:s,attempt:a,referenceBuy:q,dueAt:at+latency,afterBlock:p.block,budget,raw:0n,original:0n,decimals:q.quote.tokenDecimals,entryPrice:0,peak:0,done:new Set(),remainingCostUsd:0,reservedNative:held,pending:null,lastObservation:null});
      record(at);continue;
    }
    const pos=active.get(s.id);if(!pos)continue;
    if(p.at>at||p.removed||p.gap||p.block<pos.afterBlock){failure(pos,at,'missing/reorganized market observation',true);pos.lastObservation=null;record(at);continue;}
    if(pos.lastObservation){
      if(p.block<pos.lastObservation.block||!pos.preparationReference&&p.block===pos.lastObservation.block)continue;
      if(pos.preparationReference&&p.block===pos.lastObservation.block){
        // Main archives individual exact quotes as they arrive, including several
        // observations on one head. Keep only previously received same-head data.
        const key=(q:QuoteSnapshot)=>`${q.quote.side}:${q.quote.side==='buy'?q.requestedUsd:q.requestedTokenRaw}`;
        const replaced=new Set(p.quotes.map(key));
        p=immutableSnapshot({...p,quotes:[...p.quotes,...pos.lastObservation.quotes.filter(q=>!replaced.has(key(q)))]});
      }
    }
    pos.lastObservation=p;
    if(pos.attempt.openedAt===null){
      if(at<pos.dueAt||p.block<=pos.afterBlock)continue;
      if(pos.preparationReference&&p.quotes.length&&!p.quotes.some(q=>q.quote.side==='buy'&&q.requestedUsd===pos.budget)){
        // An unrelated size/side arriving first is not a failed request for this
        // order. Wait for its exact post-delay tuple; never invent a gas charge.
        record(at);continue;
      }
      reservedNative-=pos.reservedNative;pos.reservedNative=0n;refreshCash();
      const age=pos.preparationReference?Math.min(maxAge,5_000):maxAge;
      const q=buyAt(p,s,at,pos.budget,age);
      const e=equity(at);
      const flow=q?quoteNativeCashFlow(q.quote):null;
      const inputMatches=!!q&&raw(q.quote.inputRaw)===raw(pos.referenceBuy.quote.inputRaw);
      const slippageFailed=!!q&&inputMatches&&!quoteSlippageAccepted(pos.referenceBuy.quote,q.quote,slippage);
      const accepted=inputMatches&&!slippageFailed;
      const expired=s.signalExpiresAt!==undefined&&at>s.signalExpiresAt;
      const premium=q&&s.maxEntryPriceUsd!==undefined&&q.quote.priceUsd>s.maxEntryPriceUsd+1e-12;
      const reverse=q&&pos.preparationReference?sellAt(p,s,at,raw(q.quote.outputRaw),age):undefined;
      const fillPairKnown=!!q&&!!reverse&&raw(reverse.quote.spentInputRaw)===raw(q.quote.outputRaw)&&reverse.quote.refundRaw==='0'
        &&q.quote.fees.includedInOutput&&reverse.quote.fees.includedInOutput;
      const planned=q?pos.preparationReference?(fillPairKnown?Math.max(0,nativeUsd(q.quote.spentInputRaw,q.quote.nativeUsd)+q.quote.fees.gasUsd+q.quote.fees.approvalUsd-feeAwareStopEstimates(q.quote,reverse!.quote,[rules.stopPct],slippage,p.at)[0].netProceedsUsd):null):stopRisk(q,rules.stopPct,p.at):null;
      const referenceStale=!!pos.preparationReference&&!quoteValid(pos.referenceBuy,pos.preparationReference,s,at,age);
      const capped=q?nativeUsd(q.quote.spentInputRaw,q.quote.nativeUsd)+q.quote.fees.gasUsd+q.quote.fees.approvalUsd:Infinity;
      if(!q||!accepted||expired||premium||referenceStale||planned===null||planned>e*risk.riskPct/100+1e-6||nativeBalance===null||nativeBalance+BigInt(flow!.nativeDeltaRaw)<reservedNative||capped>e*risk.maxPositionPct/100+1e-6||q.quote.priceImpactPct>2||halt){
        const reason=expired?'wallet signal expired at fill':premium?'wallet fill price exceeds premium cap':referenceStale?'entry reference quote expired before fill':!q?'post-delay executable buy quote missing':halt|| (!inputMatches?'native quote request differs from reserved order':slippageFailed?'buy slippage exceeded':'fill-time fees/risk limit');
        pos.attempt.status='failed';pos.attempt.endedAt=at;
        const mayExecute=!expired&&!premium&&!referenceStale&&!halt;
        const knownFailure=mayExecute&&slippageFailed?chargeFailure(pos,p,at,'buy',pos.budget,'slippage',q)
          :mayExecute&&!q?chargeFailure(pos,p,at,'buy',pos.budget,'observed'):false;
        const absentExpense=slippageFailed&&mayExecute&&!knownFailure&&(q!.quote.fees.gasUsd+q!.quote.fees.approvalUsd>0||q!.executionFailurePolicy!==undefined);
        pos.attempt.netUsd=-pos.attempt.outlayUsd;failure(pos,at,absentExpense?`${reason}; simulated gas cost snapshot missing`:reason,(!q&&!knownFailure&&!expired&&!referenceStale)||!!q&&!inputMatches||absentExpense||!!pos.preparationReference&&!!q&&planned===null&&!expired&&!premium&&!referenceStale);active.delete(s.id);record(at);continue;
      }
      nativeBalance+=BigInt(flow!.nativeDeltaRaw);refreshCash();pos.raw=raw(q.tokenAmountRaw);pos.original=pos.raw;pos.decimals=q.quote.tokenDecimals;pos.entryPrice=q.quote.priceUsd;pos.peak=pos.entryPrice;
      dayEntries++;
      pos.remainingCostUsd=flow!.tradeCashUsd;
      Object.assign(pos.attempt,{openedAt:at,originalRaw:String(pos.raw),remainingRaw:String(pos.raw),outlayUsd:flow!.tradeCashUsd,feesUsd:flow!.feesUsd,reason:'filled'});
      pos.attempt.fills.push({side:'buy',at,block:p.block,quoteId:q.quote.id,tokenRaw:String(pos.raw),cashDebitUsd:flow!.cashDebitUsd,cashCreditUsd:0,feesUsd:flow!.feesUsd,reason:'entry',targets:[],nativeDeltaRaw:flow!.nativeDeltaRaw,nativeUsd:q.quote.nativeUsd});
      record(at);continue;
    }
    // Evaluate clear-all risk BEFORE a queued target executes on a changed price.
    // Replacing the order establishes a new 500ms/head boundary, not an instant fill.
    const beforePrice=exitPrice(pos,p,at);
    if(positive(beforePrice))pos.peak=Math.max(pos.peak,beforePrice);
    const clearReason=positive(beforePrice)&&beforePrice<=pos.entryPrice*(1-rules.stopPct/100)+1e-14?'stop loss'
      :pos.raw<pos.original&&(protectsCost(pos,p,at)||(positive(beforePrice)&&rules.trailPct>0&&beforePrice<=pos.peak*(1-rules.trailPct/100)))?'trailing exit'
      :at-(pos.attempt.openedAt as number)>=rules.maxHoldMs?'time exit':null;
    if(clearReason&&pos.pending&&!['stop loss','trailing exit','time exit'].includes(pos.pending.reason)){
      const reference=sellAt(p,s,at,pos.raw,maxAge)??null;
      if(pos.preparationReference&&!reference){pos.pending=null;record(at);continue;}
      if(!reference)failure(pos,at,'risk exit quote missing',true);
      pos.pending={reason:clearReason,targets:[],raw:pos.raw,dueAt:at+latency,afterBlock:p.block,reference};
    }
    if(pos.pending&&at>=pos.pending.dueAt&&p.block>pos.pending.afterBlock){
      const pending=pos.pending;
      if(pos.preparationReference&&p.quotes.length&&!p.quotes.some(q=>q.quote.side==='sell'&&raw(q.requestedTokenRaw)===pending.raw)){record(at);continue;}
      if(pos.preparationReference&&pending.reference&&!quoteValid(pending.reference,{...p,block:pending.reference.quote.block,at:pending.reference.receivedAt},s,at,Math.min(maxAge,5_000))){
        failure(pos,at,'sell reference quote expired before fill',false);pos.pending=null;record(at);continue;
      }
      const q=sellAt(p,s,at,pending.raw,maxAge);
      if(!q){const knownFailure=chargeFailure(pos,p,at,'sell',pending.raw,'observed');failure(pos,at,'sell unavailable or exact quantity/fees missing',!knownFailure);pos.pending={...pending,dueAt:at+latency,afterBlock:p.block,reference:null};record(at);continue;}
      // A missing reference is retried as a NEW request, never granted a free fill.
      if(!pending.reference){pos.pending={...pending,reference:q,dueAt:at+latency,afterBlock:p.block};record(at);continue;}
      const flow=quoteNativeCashFlow(q.quote);
      if(!quoteSlippageAccepted(pending.reference.quote,q.quote,slippage)){
        const knownFailure=chargeFailure(pos,p,at,'sell',pending.raw,'slippage',q);
        failure(pos,at,'sell slippage exceeded',!knownFailure&&(q.quote.fees.gasUsd+q.quote.fees.approvalUsd>0||q.executionFailurePolicy!==undefined));pos.pending=null;record(at);continue;
      }
      if(nativeBalance===null||nativeBalance+BigInt(flow.nativeDeltaRaw)<reservedNative){failure(pos,at,'insufficient unreserved cash for sell costs',false);pos.pending=null;record(at);continue;}
      const sold=raw(q.tokenAmountRaw);
      const allocated=sold===pos.raw?pos.remainingCostUsd:Number(BigInt(Math.round(pos.remainingCostUsd*1_000_000))*sold/pos.raw)/1_000_000;
      dayNetUsd=usdFloat(usdInt(dayNetUsd)+usdInt(flow.tradeCashUsd)-usdInt(allocated));
      pos.remainingCostUsd=Math.round((pos.remainingCostUsd-allocated)*1_000_000)/1_000_000;
      pos.raw-=sold;nativeBalance+=BigInt(flow.nativeDeltaRaw);refreshCash();
      const a=pos.attempt;a.cashBackUsd=usdFloat(usdInt(a.cashBackUsd)+usdInt(flow.tradeCashUsd));a.feesUsd+=flow.feesUsd;a.remainingRaw=String(pos.raw);a.reason=pending.reason;
      a.fills.push({side:'sell',at,block:p.block,quoteId:q.quote.id,tokenRaw:String(sold),cashDebitUsd:flow.cashDebitUsd,cashCreditUsd:flow.cashCreditUsd,feesUsd:flow.feesUsd,reason:pending.reason,targets:[...pending.targets],nativeDeltaRaw:flow.nativeDeltaRaw,nativeUsd:q.quote.nativeUsd});
      if(sold===pending.raw){pending.targets.forEach(t=>pos.done.add(t));pos.pending=null;}
      else{pos.pending={...pending,raw:pending.raw-sold,reference:null,dueAt:at+latency,afterBlock:p.block};}
      if(pos.raw===0n){close(pos,at);record(at);continue;}
    }
    // A partial fill changes the whole-remaining quantity; reselect its exact
    // quote now, rather than reusing the price for the preceding position size.
    const price=exitPrice(pos,p,at);
    const expired=at-(pos.attempt.openedAt as number)>=rules.maxHoldMs;
    if(!positive(price)&&!expired){failure(pos,at,'fresh exit price unavailable; inventory marked zero',true);record(at);continue;}
    if(positive(price))pos.peak=Math.max(pos.peak,price);
    const gained=positive(price)?price/pos.entryPrice-1:0;
    const stopped=positive(price)&&price<=pos.entryPrice*(1-rules.stopPct/100)+1e-14;
    const trailing=pos.raw<pos.original&&(protectsCost(pos,p,at)|| (positive(price)&&rules.trailPct>0&&price<=pos.peak*(1-rules.trailPct/100)));
    const targets=rules.targets.flatMap((t,i)=>!pos.done.has(i)&&gained+1e-12>=t.gainPct/100?[i]:[]);
    if(stopped||trailing||expired||targets.length){
      const reason=stopped?'stop loss':trailing?'trailing exit':expired?'time exit':'take profit';
      const clear=stopped||trailing||expired;
      const targetRaw=targets.reduce((sum,i)=>sum+targetQuantity(pos.original,i),0n);
      const wanted=clear?pos.raw:targetRaw<pos.raw?targetRaw:pos.raw;
      // Clear-all risk overrides a queued partial take profit, without duplicate sells.
      if(wanted>0n&&(!pos.pending||clear&&!['stop loss','trailing exit','time exit'].includes(pos.pending.reason))){
        const reference=sellAt(p,s,at,wanted,maxAge)??null;
        if(pos.preparationReference&&!reference){record(at);continue;}
        if(!reference)failure(pos,at,'trigger quote missing; exit queued without invented fill',true);
        pos.pending={reason,targets:clear?[]:targets,raw:wanted,dueAt:at+latency,afterBlock:p.block,reference};
      }
    }
    record(at);
  }
  for(const state of preparing.values())if(!state.settled){
    prepMissing(state,options.to,'entry preparation purged at window boundary');
    finishPreparation(state,options.to,'entry preparation purged at window boundary');
  }
  for(const pos of active.values()){
    const a=pos.attempt;
    if(a.openedAt===null){reservedNative-=pos.reservedNative;pos.reservedNative=0n;refreshCash();a.status='failed';a.reason='no fresh head/quote before boundary';a.missing=true;issues.push(`${a.sampleId}: ${a.reason}`);}
    else{
      a.status='purged';a.reason='open position purged at window boundary; no carry or synthetic sale';
      a.conservativeValueUsd=mark(pos,options.to);a.remainingRaw=String(pos.raw);a.netUsd=a.cashBackUsd+a.conservativeValueUsd-a.outlayUsd;
      if(a.conservativeValueUsd===0&&pos.raw>0n){a.missing=true;issues.push(`${a.sampleId}: unknown/unsellable inventory valued zero`);}
    }
    a.endedAt=options.to;
  }
  record(options.to);
  for(const s of samples)if(s.coveredThrough<options.to && attempts.some(a=>a.sampleId===s.id&&a.status==='purged'))issues.push(`${s.id}: collection ends before evaluation boundary`);
  const closed=attempts.filter(a=>a.status==='closed');
  const wins=closed.filter(a=>a.netUsd>0);
  const economic=attempts.filter(a=>a.status==='closed'||a.status==='failed'||a.status==='purged');
  const profit=economic.filter(a=>a.netUsd>0).reduce((n,a)=>n+a.netUsd,0),loss=-economic.filter(a=>a.netUsd<0).reduce((n,a)=>n+a.netUsd,0);
  const net=(curve.at(-1)?.equityUsd??initial)-initial;
  const returnPct=net/initial*100;
  const metrics:Metrics={count:closed.length,tokens:new Set(closed.map(a=>a.token.toLowerCase())).size,netUsd:net,returnPct,profitFactor:loss>0?profit/loss:profit>0?null:0,maxDrawdownPct:maxDD,winRate:closed.length?wins.length/closed.length*100:0,score:returnPct/Math.max(maxDD,1),feesUsd:attempts.reduce((n,a)=>n+a.feesUsd,0)};
  // Unclosed/failed positions can never make the completed-trade PF look eligible.
  const authoritative=issues.length===0 && attempts.every(a=>!a.missing&&a.status!=='purged') && samples.length>0;
  const {fxTrace:unusedFx,...policy}=options;
  const idle=idleBenchmark(),trading=economic.reduce((n,a)=>n+a.netUsd,0);
  const realized=economic.reduce((n,a)=>n+a.cashBackUsd-a.outlayUsd+(active.get(a.sampleId)?.remainingCostUsd??0),0);
  const nativeAccounting:ReplayResult['nativeAccounting']={policy:NATIVE_ACCOUNTING_POLICY,fundedAt,initialFx,finalFx:fx,initialNativeRaw:initialNative===null?null:String(initialNative),finalNativeRaw:nativeBalance===null?null:String(nativeBalance),reservedNativeRaw:String(reservedNative),cashUsd:cash,realizedTradingUsd:realized,conservativeTradingUsd:trading,unrealizedTradingUsd:trading-realized,nativeCashFxUsd:net-trading,idleBenchmarkEquityUsd:idle,idleBenchmarkNetUsd:idle-initial,excessOverIdleUsd:(curve.at(-1)?.equityUsd??initial)-idle,fxTraceHash:researchDataHash(fxSeries)};
  return {metrics,attempts,equity:curve,nativeAccounting,dataHash:researchDataHash({samples,rules,fxSeries,accountingPolicy:NATIVE_ACCOUNTING_POLICY,options:{...policy,risk,initialCapitalUsd:initial,latencyMs:latency,slippagePct:slippage,maxQuoteAgeMs:maxAge}}),authoritative,issues:[...new Set(issues)],from:options.from,to:options.to};
}

export interface TestWindow { from:number;to:number;runId:string;dataHash:string; }
export interface ResearchRequest {
  strategyId:string;chain:Chain;horizon:Horizon;samples:readonly ResearchSample[];
  validationEnd:number;now:number;runId?:string;seed?:number;
  /** Main MUST pass the durable archive here, including failed final tests. */
  priorTests?:readonly TestWindow[];
  /** Sealed risk configuration; changes require a new experiment/version. */
  risk?:RiskConfig;
  fxTrace?:readonly Immutable<NativeFxSnapshot>[];
}
export interface CandidateResult { candidate:ExitCandidate;training:ReplayResult;validation:ReplayResult|null;reason:string; }
export interface FrozenResearchVersion {
  runId:string;strategyId:string;chain:Chain;horizon:Horizon;candidateId:string;rules:ExitRules;
  selectedAt:number;forwardStart:number;forwardEnd:number;seed:number;
  trainStart:number;trainEnd:number;validationEnd:number;training:Metrics;validation:Metrics;
  trainingDataHash:string;validationDataHash:string;selectionHash:string;
  risk:RiskConfig;
  accountingPolicy:typeof NATIVE_ACCOUNTING_POLICY;
}
export interface ResearchEvaluation {run:ResearchRun;attempts:CandidateResult[];baselines:CandidateResult[];frozen:Immutable<FrozenResearchVersion>|null;}
export interface ForwardRequest {frozen:Immutable<FrozenResearchVersion>;samples:readonly ResearchSample[];now:number;priorTests?:readonly TestWindow[];fxTrace?:readonly Immutable<NativeFxSnapshot>[];}
export interface ForwardEvaluation {status:'collecting'|'passed'|'failed';reason:string;result:ReplayResult;lower90Usd:number;testWindow:TestWindow;selectionHash:string;}
export function researchWindows(validationEnd:number):{trainStart:number;trainEnd:number;validationEnd:number} {
  return {trainStart:validationEnd-21*DAY_MS,trainEnd:validationEnd-7*DAY_MS,validationEnd};
}
function enough(r:ReplayResult,n:number,tokens:number):boolean {return r.authoritative&&r.metrics.count>=n&&r.metrics.tokens>=tokens;}
export function passesFormalMetrics(m:Metrics):boolean {
  const pf=m.profitFactor===null?m.netUsd>0:finite(m.profitFactor)&&m.profitFactor>=1.2;
  return finite(m.netUsd)&&m.netUsd>0&&pf&&finite(m.maxDrawdownPct)&&m.maxDrawdownPct>=0&&m.maxDrawdownPct<=10+1e-10;
}
function overlap(a:{from:number;to:number},b:{from:number;to:number}):boolean {return a.from<b.to&&b.from<a.to;}
function seal(f:Immutable<Omit<FrozenResearchVersion,'selectionHash'>>|Immutable<FrozenResearchVersion>):string {
  const {selectionHash:ignored,...rest}=f as Immutable<FrozenResearchVersion>;return researchDataHash(rest);
}
export function runResearch(request:ResearchRequest):ResearchEvaluation {
  const {validationEnd,now,chain,horizon,strategyId}=request;
  if(!finite(now)||!finite(validationEnd)||validationEnd>now)throw new Error('Validation must end before selection');
  const window=researchWindows(validationEnd),seed=request.seed??RESEARCH_SEED,risk={...DEFAULT_RISK,...request.risk};
  if(!validRisk(risk))throw new Error('Research risk limits may be tightened, never relaxed');
  const dataset=clippedSamples(request.samples,window.trainStart,validationEnd);
  const fxTrace=clippedFx(request.fxTrace??[],window.trainStart,validationEnd,chain);
  const dataHash=researchDataHash({dataset,risk,fxTrace,accountingPolicy:NATIVE_ACCOUNTING_POLICY}),id=request.runId??`research-${researchDataHash({strategyId,window,dataHash,seed}).slice(0,24)}`;
  const run:ResearchRun={id,strategyId,status:'collecting',createdAt:now,...window,forwardStart:null,forwardEnd:null,seed,dataHash,selectedRules:null,candidates:[],training:null,validation:null,forward:null,reason:'Waiting for authoritative samples',promotedAt:null};
  if(request.priorTests?.some(t=>overlap({from:window.trainStart,to:validationEnd},t))){run.status='failed';run.reason='Window overlaps a previously sealed final test; no reused test tuning';return {run,attempts:[],baselines:[],frozen:null};}
  const trainOptions={from:window.trainStart,to:window.trainEnd,chain,risk,fxTrace};
  const validationOptions={from:window.trainEnd,to:validationEnd,chain,risk,fxTrace};
  const attempts=exitGrid(horizon).map(candidate=>({candidate,training:replayPortfolio(dataset,candidate.rules,trainOptions),validation:null as ReplayResult|null,reason:'training only'}));
  const baseline=legacyBaseline();
  const baselines:CandidateResult[]=[{candidate:baseline,training:replayPortfolio(dataset,baseline.rules,trainOptions),validation:replayPortfolio(dataset,baseline.rules,validationOptions),reason:'Separate losing baseline; never eligible for selection'}];
  const best=attempts.filter(a=>enough(a.training,100,1)).sort((a,b)=>b.training.metrics.score-a.training.metrics.score||a.candidate.id.localeCompare(b.candidate.id,'en')).slice(0,5);
  best.forEach(a=>{a.validation=replayPortfolio(dataset,a.candidate.rules,validationOptions);a.reason=enough(a.validation,50,20)&&passesFormalMetrics(a.validation.metrics)?'validation eligible':'validation sample/quality/performance gate failed';});
  run.candidates=attempts.map(a=>({id:a.candidate.id,rules:a.candidate.rules,training:a.training.metrics,validation:a.validation?.metrics??null,reason:a.reason}));
  const winner=best.filter(a=>a.validation&&enough(a.validation,50,20)&&passesFormalMetrics(a.validation.metrics)).sort((a,b)=>(b.validation as ReplayResult).metrics.score-(a.validation as ReplayResult).metrics.score||a.candidate.id.localeCompare(b.candidate.id,'en'))[0];
  if(!winner){run.status=best.length?'failed':'collecting';run.reason=best.length?'No validation candidate passed; retain every attempt and wait for new data':'Need 100 complete authoritative training rounds; candles, missing quotes and fees cannot promote';return {run,attempts,baselines,frozen:null};}
  const validation=winner.validation as ReplayResult;
  const payload:Omit<FrozenResearchVersion,'selectionHash'>={runId:id,strategyId,chain,horizon,candidateId:winner.candidate.id,rules:structuredClone(winner.candidate.rules),selectedAt:now,forwardStart:now,forwardEnd:now+7*DAY_MS,seed,...window,training:winner.training.metrics,validation:validation.metrics,trainingDataHash:winner.training.dataHash,validationDataHash:validation.dataHash,risk,accountingPolicy:NATIVE_ACCOUNTING_POLICY};
  const frozen=immutableSnapshot({...payload,selectionHash:seal(payload)});
  Object.assign(run,{status:'forward',training:winner.training.metrics,validation:validation.metrics,selectedRules:structuredClone(winner.candidate.rules),forwardStart:now,forwardEnd:now+7*DAY_MS,reason:'Parameters sealed; waiting for seven NEW days of forward paper quotes'});
  return {run,attempts,baselines,frozen};
}

/** Main-clock sealing after heavy computation; no old quotes can become "new". */
export function freezeResearchWinner(evaluation:ResearchEvaluation,actualFreezeAt:number):ResearchEvaluation {
  if(!finite(actualFreezeAt)||actualFreezeAt<evaluation.run.createdAt||actualFreezeAt<evaluation.run.validationEnd)throw new Error('Freeze must occur after selection and validation');
  if(!evaluation.frozen)return evaluation;
  const f=evaluation.frozen;
  if(f.selectionHash!==seal(f))throw new Error('Selected research version was altered');
  const {selectionHash:oldSeal,...payload}=f;
  const next={...structuredClone(payload),selectedAt:actualFreezeAt,forwardStart:actualFreezeAt,forwardEnd:actualFreezeAt+7*DAY_MS};
  const frozen=immutableSnapshot({...next,selectionHash:seal(next)});
  return {...evaluation,frozen,run:{...evaluation.run,forwardStart:frozen.forwardStart,forwardEnd:frozen.forwardEnd}};
}

/** Fixed-seed cluster bootstrap: draw TOKEN clusters, keeping all within-token rows. */
export function tokenClusterBootstrap(trades:readonly {token:string;netUsd:number}[],seed=RESEARCH_SEED,iterations=2_000):number {
  if(!trades.length)return 0;
  if(!Number.isInteger(iterations)||iterations<100)throw new Error('Bootstrap requires at least 100 draws');
  const clusters=new Map<string,number>();
  for(const t of trades){if(!finite(t.netUsd))throw new Error('Invalid trade return');const key=t.token.toLowerCase();clusters.set(key,(clusters.get(key)??0)+t.netUsd);}
  const values=[...clusters.entries()].sort(([a],[b])=>a.localeCompare(b,'en')).map(([,v])=>v);
  let state=seed>>>0;
  const random=()=>{state=(state+0x6d2b79f5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
  const results:number[]=[];
  for(let i=0;i<iterations;i++){let sum=0;for(let j=0;j<values.length;j++)sum+=values[Math.floor(random()*values.length)];results.push(sum);}
  results.sort((a,b)=>a-b);
  // One-sided 90% lower confidence bound, not the 5th percentile of a two-sided CI.
  return results[Math.floor(.10*(iterations-1))];
}
export function evaluateForward(request:ForwardRequest):ForwardEvaluation {
  const f=request.frozen;
  if(!finite(request.now)||request.now<f.selectedAt)throw new Error('Forward clock precedes parameter freeze');
  if(f.accountingPolicy!==NATIVE_ACCOUNTING_POLICY||f.selectionHash!==seal(f)||f.forwardStart<f.selectedAt||f.forwardEnd!==f.forwardStart+7*DAY_MS||!passesFormalMetrics(f.validation)||f.validation.count<50||f.validation.tokens<20||f.training.count<100)throw new Error('Frozen version invalid or altered');
  if(request.priorTests?.some(w=>overlap({from:f.forwardStart,to:f.forwardEnd},w)))throw new Error('Final test window already consumed; never retune or reuse it');
  const samples=clippedSamples(request.samples,f.forwardStart,Math.min(request.now,f.forwardEnd));
  const result=replayPortfolio(samples,f.rules,{from:f.forwardStart,to:Math.max(f.forwardStart+1,Math.min(request.now,f.forwardEnd)),chain:f.chain,risk:f.risk,fxTrace:request.fxTrace});
  const preRecorded=samples.some(s=>s.capturedAt<f.forwardStart||s.signalAt<f.forwardStart||s.entry.at<f.forwardStart);
  const lower90Usd=tokenClusterBootstrap(result.attempts.filter(a=>a.status==='closed'||a.status==='purged'||a.status==='failed').map(a=>({token:a.token,netUsd:a.netUsd})),f.seed);
  result.metrics.lower90Usd=lower90Usd;
  const window={from:f.forwardStart,to:f.forwardEnd,runId:f.runId,dataHash:result.dataHash};
  if(request.now<f.forwardEnd)return {status:'collecting',reason:'Seven NEW forward days have not completed; no early promotion',result,lower90Usd,testWindow:window,selectionHash:f.selectionHash};
  const passed=!preRecorded&&enough(result,50,20)&&passesFormalMetrics(result.metrics)&&lower90Usd>0;
  return {status:passed?'passed':'failed',reason:preRecorded?'Forward evidence was archived before parameter freeze':passed?'All sealed forward sample, net, PF, drawdown and clustered bootstrap gates passed':'Forward sample/quality/performance/bootstrap gate failed; preserve this test and wait for NEW data',result,lower90Usd,testWindow:window,selectionHash:f.selectionHash};
}

export type ResearchWorkerJob = {kind:'train';request:ResearchRequest}|{kind:'forward';request:ForwardRequest}|{kind:'replay';samples:readonly ResearchSample[];rules:ExitRules;options:ReplayOptions};
export type ResearchWorkerResult = ResearchEvaluation|ForwardEvaluation|ReplayResult;
export function executeResearchJob(job:ResearchWorkerJob):ResearchWorkerResult {
  if(job.kind==='train')return runResearch(job.request);
  if(job.kind==='forward')return evaluateForward(job.request);
  return replayPortfolio(job.samples,job.rules,job.options);
}
/** Worker owns only heavy computation; main alone persists and schedules results. */
export interface ResearchWorkerOptions {signal?:AbortSignal;timeoutMs?:number;}
export function runResearchInWorker(job:Extract<ResearchWorkerJob,{kind:'train'}>,options?:ResearchWorkerOptions):Promise<ResearchEvaluation>;
export function runResearchInWorker(job:Extract<ResearchWorkerJob,{kind:'forward'}>,options?:ResearchWorkerOptions):Promise<ForwardEvaluation>;
export function runResearchInWorker(job:Extract<ResearchWorkerJob,{kind:'replay'}>,options?:ResearchWorkerOptions):Promise<ReplayResult>;
export function runResearchInWorker(job:ResearchWorkerJob,options?:ResearchWorkerOptions):Promise<ResearchWorkerResult>;
export function runResearchInWorker(job:ResearchWorkerJob,options:ResearchWorkerOptions={}):Promise<ResearchWorkerResult> {
  return new Promise((resolve,reject)=>{
    if(options.signal?.aborted){reject(new Error('Research aborted'));return;}
    const url=new URL('./research-worker.js',import.meta.url);
    // Source development uses the already-installed tsx loader; compiled production
    // workers run plain JavaScript, with no install/network/bootstrap shell command.
    const source=import.meta.url.endsWith('.ts');
    const worker=source?new Worker(`import('tsx/esm/api').then(({tsImport})=>tsImport(${JSON.stringify(new URL('./research-worker.ts',import.meta.url).href)},${JSON.stringify(import.meta.url)})).catch(e=>{throw e})`,{eval:true,workerData:job,execArgv:[]}):new Worker(url,{workerData:job,execArgv:[]});
    let finished=false;
    const timeout=setTimeout(()=>finish(new Error('Research worker timed out')),options.timeoutMs??120_000);
    const abort=()=>finish(new Error('Research aborted'));
    const finish=(error:Error|null,value?:ResearchWorkerResult)=>{
      if(finished)return;finished=true;clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);void worker.terminate();
      if(error)reject(error);else resolve(value as ResearchWorkerResult);
    };
    options.signal?.addEventListener('abort',abort,{once:true});
    worker.once('message',(message:{ok:boolean;value?:ResearchWorkerResult;error?:string})=>{
      if(!message.ok){finish(new Error(message.error??'Research worker failed'));return;}
      try{const value=job.kind==='train'?freezeResearchWinner(message.value as ResearchEvaluation,Math.max(Date.now(),job.request.now)):message.value;finish(null,value);}
      catch(error){finish(error instanceof Error?error:new Error(String(error)));}
    });
    worker.once('error',error=>finish(error));
    worker.once('exit',code=>{if(!finished)finish(new Error(`Research worker exited without a result (${code})`));});
  });
}
