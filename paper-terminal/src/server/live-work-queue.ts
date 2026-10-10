export interface LiveWork {id:string;replayed:boolean;run:()=>Promise<void>;}
/** Fetching logs must not await receipt verification. Keep FIFO within each
 * class, let live work overtake queued history, bound memory, and deduplicate. */
export class LiveWorkQueue {
 private queued:LiveWork[]=[];private ids=new Set<string>();private closed=false;
 busy=false;
 constructor(private onError:(error:unknown,job:LiveWork)=>void,private onDrop:(job:LiveWork)=>void,private limit=128){}
 add(job:LiveWork){if(this.closed||this.ids.has(job.id))return;this.ids.add(job.id);
  if(this.queued.length>=this.limit){const old=this.queued.findIndex(j=>j.replayed),drop=this.queued.splice(old>=0?old:0,1)[0];this.ids.delete(drop.id);this.onDrop(drop);}
  this.queued.push(job);void this.pump();
 }
 get pending(){return this.queued.length;}
 close(){this.closed=true;this.queued=[];this.ids.clear();}
 private async pump(){if(this.busy||this.closed)return;this.busy=true;
  try{while(this.queued.length&&!this.closed){const live=this.queued.findIndex(j=>!j.replayed),job=this.queued.splice(live>=0?live:0,1)[0];
    try{await job.run();}catch(e){this.onError(e,job);}finally{this.ids.delete(job.id);}
  }}finally{this.busy=false;}
 }
}
