import type { Market } from '../../shared/domain.js';
import { milliseconds } from './time.js';

export type ScannerStage = 'new'|'near'|'graduated';
export const SCANNER_SEED_TTL = 90_000;
export interface ScannerSeed {
 bucket:'new_creation'|'near_completion'|'completed';stage:ScannerStage;
 observedAt:number;rawCreatedAt?:number;rawCompletedAt?:number;progressPct:number|null;
}
export interface ScannerProof {stage:'curve'|'dex';block:number;source:string;ready?:boolean;}
export interface ScannerEvent {stage:'new'|'graduated';block:number;source:string;rawAt?:number;}
export interface ScannerEvidence {seed?:ScannerSeed;proof?:ScannerProof;event?:ScannerEvent;}

export function scannerBucketStage(bucket:string):ScannerStage|undefined {
 if(bucket==='new_creation')return 'new';if(bucket==='near_completion')return 'near';if(bucket==='completed')return 'graduated';
}
function actualTime(value:unknown):number|undefined {
 if(typeof value!=='number'&&typeof value!=='string'||value==='')return;
 const n=Number(value);return Number.isFinite(n)&&n>0?milliseconds(n):undefined;
}
export function scannerSeed(bucket:string,item:Record<string,unknown>,observedAt:number):ScannerSeed|undefined {
 const stage=scannerBucketStage(bucket);if(!stage)return;
 // Installed GMGN CLI documents progress as a fraction, not bps or percent.
 // Missing/null values must not coerce to zero; other ABI scales stay unknown.
 const value=item.progress,n=(typeof value==='number'||typeof value==='string'&&value.trim()!=='')?Number(value):NaN;
 return {bucket:bucket as ScannerSeed['bucket'],stage,observedAt,
  rawCreatedAt:actualTime(item.created_timestamp)||actualTime(item.creation_timestamp),
  rawCompletedAt:stage==='graduated'?actualTime(item.complete_timestamp):undefined,
  progressPct:Number.isFinite(n)&&n>=0&&n<=1?n*100:null};
}
export function mergeScannerEvidence(old:ScannerEvidence,change:ScannerEvidence):ScannerEvidence {
 const next={...old};
 if(change.seed&&(!old.seed||change.seed.observedAt>=old.seed.observedAt))next.seed=change.seed;
 if(change.proof&&(!old.proof||change.proof.block>=old.proof.block)&&!(old.proof?.stage==='dex'&&change.proof.stage==='curve'))next.proof=change.proof;
 if(change.event&&(!old.event||change.event.block>=old.event.block)&&!(old.event?.stage==='graduated'&&change.event.stage==='new'))next.event=change.event;
 return next;
}
export function invalidateScannerEvidence(old:ScannerEvidence,from:number):ScannerEvidence {
 // A cached provider category cannot re-establish a stage after a reorg.
 return {proof:old.proof&&old.proof.block<from?old.proof:undefined,event:old.event&&old.event.block<from?old.event:undefined};
}
export function scannerFields(evidence:ScannerEvidence,now:number,createdAt:number,normalize:(rawAt:number)=>number|undefined):Pick<Market,'scannerStage'|'scannerAt'|'progressPct'> {
 const {seed,proof,event}=evidence;
 const freshSeed=seed&&now>=seed.observedAt&&now-seed.observedAt<SCANNER_SEED_TTL?seed:undefined;
 const graduation=event?.stage==='graduated'?event:undefined;
 let scannerStage:ScannerStage|undefined;
 if(graduation||proof?.stage==='dex')scannerStage='graduated';
 else if(proof?.stage==='curve')scannerStage=proof.ready||freshSeed?.stage==='near'?'near':'new';
 else scannerStage=freshSeed?.stage??event?.stage;
 const compatible=!!freshSeed&&(scannerStage==='graduated'?freshSeed.stage==='graduated':scannerStage!==undefined&&freshSeed.stage!=='graduated');
 const progressPct=compatible?freshSeed!.progressPct:null;
 // Sort new/near by actual creation and completed by an actual graduation
 // timestamp if available. Never substitute catalog discovery/refresh time.
 const rawCompleted=scannerStage==='graduated'?(graduation?.rawAt||seed?.rawCompletedAt):undefined;
 const rawCreated=seed?.rawCreatedAt||(event?.stage==='new'?event.rawAt:undefined);
 const scannerAt=rawCompleted?normalize(rawCompleted):createdAt>0?createdAt:rawCreated?normalize(rawCreated):undefined;
 return {scannerStage,scannerAt:scannerStage?scannerAt:undefined,progressPct};
}
