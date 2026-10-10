import type {Strategy,ChainStatus,RobotDiagnostic} from '../shared/domain.js';
import type {Store} from './store.js';

/** Current-version observations only; ready quotes are not complete profitable rounds. */
export function robotDiagnostics(store:Store,strategies:Strategy[],context:(s:Strategy)=>string,heads:ChainStatus[],now=Date.now()):RobotDiagnostic[]{
 const samples=store.db.prepare(`SELECT COUNT(*) signals,COUNT(DISTINCT json_extract(payload,'$.token')) tokens,MAX(start) lastSignalAt,
 SUM(CASE WHEN EXISTS(SELECT 1 FROM json_each(payload,'$.entryPreparations') p WHERE json_extract(p.value,'$.status')='ready') THEN 1 ELSE 0 END) readySamples
 FROM research_samples WHERE strategyId=? AND json_extract(payload,'$.context')=?`);
 const preparations=store.db.prepare(`SELECT SUM(CASE WHEN json_extract(p.value,'$.status')='ready' THEN 1 ELSE 0 END) readyPairs,
 SUM(CASE WHEN json_extract(p.value,'$.status')='failed' THEN 1 ELSE 0 END) failedPreparations,
 SUM(CASE WHEN json_extract(p.value,'$.status')='expired' THEN 1 ELSE 0 END) expiredPreparations
 FROM research_samples r,json_each(r.payload,'$.entryPreparations') p WHERE r.strategyId=? AND json_extract(r.payload,'$.context')=?`);
 const latest=store.db.prepare(`SELECT json_extract(p.value,'$.at') at,json_extract(p.value,'$.reason') reason FROM
 (SELECT payload FROM research_samples WHERE strategyId=? AND json_extract(payload,'$.context')=? ORDER BY start DESC LIMIT 1) r,
 json_each(r.payload,'$.entryPreparations') p ORDER BY json_extract(p.value,'$.at') DESC,p.key DESC LIMIT 1`);
 const filled=store.db.prepare("SELECT COUNT(*) n FROM orders WHERE json_extract(payload,'$.accountId')=? AND json_extract(payload,'$.status') IN ('filled','partial')");
 return strategies.map(s=>{const revision=context(s),counts=samples.get(s.id,revision) as any,steps=preparations.get(s.id,revision) as any,last=latest.get(s.id,revision) as any;
  const since=Math.max(store.meta<number>('recordingSince')??now,store.meta<number>('recordingSince:'+s.id)??0),head=heads.find(h=>h.chain===s.chain);
  return {strategyId:s.id,signals:Number(counts.signals),tokens:Number(counts.tokens),readySamples:Number(counts.readySamples??0),readyPairs:Number(steps.readyPairs??0),failedPreparations:Number(steps.failedPreparations??0),expiredPreparations:Number(steps.expiredPreparations??0),filledOrders:Number(filled.get(s.accountId)?.n??0),lastSignalAt:counts.lastSignalAt??null,latestPreparationAt:last?.at??null,latestPreparationReason:last?.reason??null,collectingSince:since,earliestTrainingAt:since+21*86400000,dataFresh:!!head?.connected&&now-head.headAt>=0&&now-head.headAt<15000};
 });
}
