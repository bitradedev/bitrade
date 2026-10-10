// Run locally only. Secrets go into ignored .dev.vars, never stdout or Git.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {EncryptedVault} from '../../bi-trade/lib/vault-core.mjs';
import {validateConfig} from '../../bi-trade/lib/ai-provider.mjs';
const source=process.argv[2];if(!source)throw Error('Provide the existing bi-trade directory');
const dir=resolve(source,'data'),db=new DatabaseSync(resolve(dir,'platform.sqlite'),{readOnly:true});
const vaultKey=readFileSync(resolve(dir,'vault-key')),vault=new EncryptedVault(vaultKey);
const row=db.prepare("SELECT payload FROM entities WHERE kind='settings' AND id='ai-provider'").get();
const config=row?validateConfig(JSON.parse(vault.decrypt(JSON.parse(row.payload).encrypted,'ai-provider:v1'))):null;
let gmgnKey=process.env.GMGN_API_KEY;for(const path of [resolve(source,'..','.env'),resolve(homedir(),'.config/gmgn/.env')]){if(!existsSync(path))continue;const match=readFileSync(path,'utf8').match(/^\s*GMGN_API_KEY\s*=\s*(.*?)\s*$/m);if(match)gmgnKey=match[1].replace(/^(['"])(.*)\1$/,'$2');}
const previous=existsSync('.dev.vars')?readFileSync('.dev.vars','utf8'):'';
const migration=previous.match(/^BI_TRADE_MIGRATION_TOKEN=(.+)$/m)?.[1]??randomBytes(32).toString('hex');
const values={SITE_ORIGIN:'http://127.0.0.1:8796',BI_TRADE_SHOWCASE_PAUSED:'true',BI_TRADE_VAULT_KEY:vaultKey.toString('base64'),BI_TRADE_MIGRATION_TOKEN:migration,...(gmgnKey?{GMGN_API_KEY:gmgnKey}:{}),...(config?{BI_TRADE_AI_API_KEY:config.apiKey,BI_TRADE_AI_BASE_URL:config.baseUrl,BI_TRADE_AI_MODEL:config.model}:{})};
if(Object.values(values).some(v=>/[\r\n]/.test(v)))throw Error('Configuration contains invalid newline');
writeFileSync('.dev.vars',Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
const excluded=new Set(['pairings','owner-actions','cloud-settings','cloud-markets','cloud-metadata']);
const entities=db.prepare('SELECT kind,id,payload FROM entities').all().filter(r=>!excluded.has(r.kind));
for(const r of entities){const v=JSON.parse(r.payload);if(r.kind==='agents'){v.mode='paper';v.paused=true;r.payload=JSON.stringify(v);}if(r.kind==='paper-orders'&&['queued','preparing','quoting'].includes(v.status)){v.status='cancelled';v.error='迁移期间未假定成交；请重新提交核价';r.payload=JSON.stringify(v);}}
const snapshot={version:1,entities,intents:db.prepare('SELECT * FROM intents').all(),audit:db.prepare('SELECT at,owner,agent,kind,message FROM audit').all()};
mkdirSync('cloudflare/data',{recursive:true});writeFileSync('cloudflare/data/migration.json',JSON.stringify(snapshot),{mode:0o600});db.close();
console.log(JSON.stringify({prepared:true,aiConfigured:!!config,marketConfigured:!!gmgnKey,entities:entities.length,agents:entities.filter(r=>r.kind==='agents').length,balancesAndHistoryPreserved:true}));
