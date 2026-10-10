import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
const source=process.argv[2];if(!source)throw Error('Provide the existing bi-trade directory');const db=new DatabaseSync(resolve(source,'data/platform.sqlite'));
const rows=db.prepare("SELECT id,payload FROM entities WHERE kind='agents'").all().filter(r=>JSON.parse(r.payload).source==='builtin');
db.exec('BEGIN IMMEDIATE');try{for(const row of rows){const a=JSON.parse(row.payload);a.paused=true;db.prepare("UPDATE entities SET payload=? WHERE kind='agents' AND id=?").run(JSON.stringify(a),a.id);
 for(const o of db.prepare("SELECT id,payload FROM entities WHERE kind='paper-orders'").all()){const v=JSON.parse(o.payload);if(v.agentId!==a.id||!['preparing','queued','quoting'].includes(v.status))continue;v.status='cancelled';v.error='已切换到 Cloudflare；未假定迁移期间成交';db.prepare("UPDATE entities SET payload=? WHERE kind='paper-orders' AND id=?").run(JSON.stringify(v),v.id);}}
 db.exec('COMMIT');console.log(JSON.stringify({pausedLocalBuiltinAgents:rows.length,historyPreserved:true}));}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
