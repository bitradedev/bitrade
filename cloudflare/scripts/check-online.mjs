import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
const {ProxyAgent,fetch}=createRequire(realpathSync('node_modules/gmgn-cli/package.json'))('undici'),proxy=process.env.HTTPS_PROXY,dispatcher=proxy?new ProxyAgent(proxy):undefined;
try{const token=readFileSync('.dev.vars','utf8').match(/^BI_TRADE_MIGRATION_TOKEN=(.+)$/m)?.[1];if(!token)throw Error('Migration token is missing');
 const r=await fetch('https://bitrade.site/__admin/check-ai?verify='+Date.now(),{dispatcher,method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Cache-Control':'no-store'},body:'{}'}),v=await r.json();console.log(JSON.stringify({status:r.status,...v}));if(!v.ok)process.exitCode=1;
}finally{await dispatcher?.close();}
