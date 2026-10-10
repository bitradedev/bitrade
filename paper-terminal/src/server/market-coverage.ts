interface AuditRow {id:number;at:number;kind:string;message?:string;details:string|Record<string,any>;}
export function assessScanFreshness(chains:readonly {chain:string;head:number;scanHead?:number;lastScanError?:string}[]){
 return chains.map(row=>{const limit=row.chain==='bsc'?64:row.chain==='robinhood'?256:0;
  const available=limit>0&&Number.isSafeInteger(row.head)&&row.head>0&&Number.isSafeInteger(row.scanHead)&&row.scanHead!>0&&row.scanHead!<=row.head&&typeof row.lastScanError==='string';
  const lag=available?row.head-row.scanHead!:null;
  return {chain:row.chain,scanHead:row.scanHead??null,lagBlocks:lag,lastScanError:row.lastScanError??'缺少扫描进度证据',current:available&&lag!<=limit&&row.lastScanError===''};
 });
}
export function assessMarketCoverage(rows:readonly AuditRow[],startedAt:number){
 const losses:{id:number;at:number;chain:string;kind:string;details:Record<string,any>}[]=[],ignoredStartupRecovery:AuditRow[]=[];
 for(const row of rows){
  if(row.kind!=='gap'&&row.kind!=='gateway')continue;
  let event:Record<string,any>;try{event=typeof row.details==='string'?JSON.parse(row.details):row.details;}catch{event={reason:'缺口记录无法解析'};}
  if(row.kind==='gateway'){
   // A failed live proof also leaves an event unprocessed. Do not let a
   // timeout appear complete merely because the bounded queue did not overflow.
   // Historical replay and unrelated quote/metadata failures stay archived.
   if(!['BSC 实时事件核验失败','Robinhood 实时事件核验失败'].includes(row.message??'')||event.replayed!==false)continue;
   const chain=row.message!.startsWith('BSC')?'bsc':'robinhood';losses.push({id:row.id,at:row.at,chain,kind:'proof-failure',details:event});continue;
  }
  const reason=String(event.payload?.reason??event.reason??'');
  // Only the explicitly replayed, initial cursor recovery is outside the live
  // coverage window. Later scanner holes and every live proof overflow remain
  // failures even while both chain heads are fresh and all books reconcile.
  if(event.replayed===true&&row.at-startedAt>=0&&row.at-startedAt<=15000&&reason.startsWith('缺口超过')){ignoredStartupRecovery.push(row);continue;}
  const chain=['bsc','robinhood'].includes(event.chain)?event.chain:'unknown',kind=String(event.id??'').startsWith('gap:proof:')||reason.includes('队列溢出')?'proof-overflow':'scan-gap';
  losses.push({id:row.id,at:row.at,chain,kind,details:event});
 }
 const groups=new Map<string,{key:string;chain:string;kind:string;count:number;firstAt:number;lastAt:number}>();
 for(const row of losses){const key=row.chain+':'+row.kind,group=groups.get(key);if(group){group.count++;group.lastAt=row.at;}else groups.set(key,{key,chain:row.chain,kind:row.kind,count:1,firstAt:row.at,lastAt:row.at});}
 return {passed:losses.length===0,losses,issues:[...groups.values()],ignoredStartupRecovery};
}
