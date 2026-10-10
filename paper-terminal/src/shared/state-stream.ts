import type {AppState} from './domain.js';

type Id=string|number;
type Row=Record<string,unknown>;
export interface ListChange {upsert:Row[];remove:Id[];order?:Id[];}
export interface FieldChange {fields:Record<string,unknown>;removedFields:string[];}
export interface StateChange extends FieldChange {collections:Record<string,ListChange>;health?:FieldChange;}
export interface StateSnapshot {type:'state-snapshot';streamId:string;revision:number;state:AppState;}
export interface StateDelta {type:'state-delta';streamId:string;baseRevision:number;revision:number;patch:StateChange;}
const listIds:Record<string,string>={chains:'chain',markets:'id',accounts:'id',positions:'id',orders:'id',fills:'id',strategies:'id',researchRuns:'id',audit:'id',controlActivity:'id'};
const record=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const equal=(a:unknown,b:unknown)=>Object.is(a,b)||JSON.stringify(a)===JSON.stringify(b);
const safeKey=(key:string)=>{if(['__proto__','prototype','constructor'].includes(key))throw Error('状态字段无效');};
function index(rows:unknown[],idKey:string):Map<Id,Row>|null {
 const result=new Map<Id,Row>();
 for(const row of rows){if(!record(row))return null;const id=row[idKey];if((typeof id!=='string'&&typeof id!=='number')||result.has(id))return null;result.set(id,row);}
 return result;
}
function fields(previous:Row,next:Row):FieldChange {
 const changed:FieldChange={fields:{},removedFields:[]};
 for(const key of Object.keys(next)){safeKey(key);if(next[key]===undefined){if(Object.hasOwn(previous,key))changed.removedFields.push(key);}else if(!equal(previous[key],next[key]))changed.fields[key]=next[key];}
 for(const key of Object.keys(previous))if(!Object.hasOwn(next,key))changed.removedFields.push(key);
 return changed;
}
export function stateChange(previous:AppState,next:AppState):StateChange {
 const before=previous as unknown as Row,after=next as unknown as Row;
 const change:StateChange={fields:{},removedFields:[],collections:{}};
 for(const key of Object.keys(after)){
  safeKey(key);if(after[key]===undefined){if(Object.hasOwn(before,key))change.removedFields.push(key);continue;}if(equal(before[key],after[key]))continue;
  if(key==='health'&&record(before[key])&&record(after[key])){change.health=fields(before[key],after[key]);continue;}
  const idKey=listIds[key],oldRows=before[key],newRows=after[key];
  if(idKey&&Array.isArray(oldRows)&&Array.isArray(newRows)){
   const oldIndex=index(oldRows,idKey),newIndex=index(newRows,idKey);
   if(oldIndex&&newIndex){
    const delta:ListChange={upsert:[],remove:[]};
    for(const [id,row] of newIndex)if(!equal(oldIndex.get(id),row))delta.upsert.push(row);
    for(const id of oldIndex.keys())if(!newIndex.has(id))delta.remove.push(id);
    const oldOrder=[...oldIndex.keys()],newOrder=[...newIndex.keys()];
    if(!equal(oldOrder,newOrder))delta.order=newOrder;
    change.collections[key]=delta;continue;
   }
  }
  change.fields[key]=after[key];
 }
 for(const key of Object.keys(before))if(!Object.hasOwn(after,key))change.removedFields.push(key);
 return change;
}
function applyFields(base:Row,change:FieldChange):Row {
 if(!record(change)||!record(change.fields)||!Array.isArray(change.removedFields))throw Error('状态更新格式无效');
 const result={...base};
 for(const key of change.removedFields){if(typeof key!=='string')throw Error('状态字段无效');safeKey(key);delete result[key];}
 for(const [key,value] of Object.entries(change.fields)){safeKey(key);result[key]=value;}
 return result;
}
export function applyStateChange(previous:AppState,change:StateChange):AppState {
 if(!record(change.collections))throw Error('状态集合格式无效');
 const result=applyFields(previous as unknown as Row,change);
 if(change.health){if(!record(result.health))throw Error('完整健康状态尚未收到');result.health=applyFields(result.health,change.health);}
 for(const [key,delta] of Object.entries(change.collections)){
  safeKey(key);const idKey=listIds[key],rows=result[key];
  if(!idKey||!Array.isArray(rows)||!record(delta)||!Array.isArray(delta.upsert)||!Array.isArray(delta.remove))throw Error('状态集合更新无效');
  const map=index(rows,idKey),upserts=index(delta.upsert,idKey);if(!map||!upserts)throw Error('状态条目缺少唯一编号');
  for(const id of delta.remove){if(typeof id!=='string'&&typeof id!=='number')throw Error('状态编号无效');map.delete(id);}
  for(const [id,row] of upserts)map.set(id,row);
  const order=delta.order??[...map.keys()];
  if(!Array.isArray(order)||order.length!==map.size||new Set(order).size!==map.size||order.some(id=>!map.has(id)))throw Error('状态顺序与条目不一致');
  result[key]=order.map(id=>map.get(id)!);
 }
 return result as unknown as AppState;
}
export function newerState(previous:AppState|null,next:AppState,seenGenerations:ReadonlySet<string>):boolean {
 if(!previous)return true;
 if(previous.csrf!==next.csrf)return !seenGenerations.has(next.csrf);
 if(Number.isSafeInteger(previous.stateRevision)&&Number.isSafeInteger(next.stateRevision))return next.stateRevision!>previous.stateRevision!;
 return next.at>=previous.at;
}

// This baseline belongs to the event stream. A newer HTTP refresh must not
// replace it: subsequent deltas are relative to the last streamed revision.
export class StateStreamReceiver {
 private baseline:AppState|null=null;private streamId='';private revision=-1;
 accept(value:unknown):AppState {
  if(!record(value))throw Error('状态消息格式无效');
  if(value.type==='state'&&record(value.state)){this.baseline=null;this.streamId='';this.revision=-1;return value.state as unknown as AppState;}
  if(typeof value.streamId!=='string'||!value.streamId||!Number.isSafeInteger(value.revision)||Number(value.revision)<0)throw Error('状态消息缺少版本');
  if(value.type==='state-snapshot'){
   if(!record(value.state))throw Error('完整状态格式无效');
   if(this.baseline&&value.streamId===this.streamId&&Number(value.revision)<=this.revision)throw Error('完整状态版本已过期');
   this.baseline=value.state as unknown as AppState;this.streamId=value.streamId;this.revision=Number(value.revision);return this.baseline;
  }
  if(value.type!=='state-delta'||!this.baseline||value.streamId!==this.streamId||value.baseRevision!==this.revision||value.revision!==this.revision+1||!record(value.patch))throw Error('状态版本不连续，需要重新同步');
  const next=applyStateChange(this.baseline,value.patch as unknown as StateChange);
  this.baseline=next;this.revision=Number(value.revision);return next;
 }
}
