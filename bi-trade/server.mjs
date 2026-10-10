import {writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlatformApp} from './platform.mjs';
export {createPublicApp,fillCsv} from './legacy-server.mjs';
export {createPlatformApp} from './platform.mjs';
const here=dirname(fileURLToPath(import.meta.url));
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const production=process.env.NODE_ENV==='production';
 if(production&&!process.env.BI_TRADE_ORIGIN)throw Error('公开部署须配置BI_TRADE_ORIGIN');
 const app=await createPlatformApp({origin:process.env.BI_TRADE_ORIGIN??'http://127.0.0.1:8794',production,liveEnabled:production&&process.env.BI_TRADE_ENABLE_LIVE==='BSC_MAINNET_ENABLED'});
 if(app.live.enabled&&!process.env.BI_TRADE_ORIGIN?.startsWith('https://'))throw Error('实盘执行仅允许显式配置的HTTPS生产站点');
 const url=await app.start(Number(process.env.BI_TRADE_PORT??8794),process.env.BI_TRADE_HOST??'127.0.0.1');
 writeFileSync(resolve(here,'data/runtime.json'),JSON.stringify({app:'bi-trade',pid:process.pid,project:here,at:Date.now(),url,liveEnabled:app.live.enabled}));
 console.log('bi trade ready:',url,'; live execution:',app.live.enabled?'ENABLED':'LOCKED');
 let stopping=false;async function stop(){if(stopping)return;stopping=true;await app.close();process.exit(0);}process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
