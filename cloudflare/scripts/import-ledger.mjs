import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const {ProxyAgent,fetch}=createRequire(realpathSync('node_modules/gmgn-cli/package.json'))('undici');
const origin=process.argv[2];if(!origin||!['https://bitrade.site','http://127.0.0.1:8796'].includes(origin))throw Error('Import target must be the authorized site or local preview');
const token=readFileSync('.dev.vars','utf8').match(/^BI_TRADE_MIGRATION_TOKEN=(.+)$/m)?.[1];if(!token)throw Error('Migration token is missing');
const proxy=process.env.HTTPS_PROXY,dispatcher=proxy&&!origin.startsWith('http:')?new ProxyAgent(proxy):undefined;
try{const r=await fetch(origin+'/__admin/import?verify='+Date.now(),{method:'POST',dispatcher,redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Cache-Control':'no-store'},body:readFileSync('cloudflare/data/migration.json')});
 if(!r.ok){const body=await r.json().catch(()=>({}));const known=['Import requires an unused database','Import already completed','Import is already running','Invalid snapshot'];throw Error('Ledger import failed: HTTP '+r.status+(known.includes(body.error)?' ('+body.error+')':''));}const value=await r.json();console.log(JSON.stringify(value));
}finally{await dispatcher?.close();}
