import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PlatformStore} from './lib/database.mjs';
import {WalletVault} from './lib/vault.mjs';
import {SharedGateway} from '../paper-trial/gateway.mjs';
import {TokenRiskGuard} from './lib/token-risk.mjs';
import {createPlatformCore} from './platform-core.mjs';
export {toolsList} from './platform-core.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export async function createPlatformApp(options={}){
 const directory=resolve(options.dataDir??resolve(here,'data')),store=options.store??new PlatformStore(directory);
 const vault=options.vault??new WalletVault(directory,{key:options.vaultKey??process.env.BI_TRADE_VAULT_KEY,production:options.production??process.env.NODE_ENV==='production',existingWallets:store.all('agents').length>0});
 let app;const gap=c=>{if(!c||c==='bsc')app?.paper.gap();},gateway=options.gateway??new SharedGateway(undefined,gap,gap);
 const riskGuard=options.showcase===false?null:options.showcaseOptions?.riskGuard??new TokenRiskGuard(store);
 app=await createPlatformCore({...options,store,vault,gateway,riskGuard,assetReader:name=>readFileSync(resolve(here,'web',name))});
 const server=createServer(app.handler);server.requestTimeout=15000;server.headersTimeout=10000;let timer,sourceTask;
 return {...app,server,async start(port=8794,host='127.0.0.1'){await new Promise((ok,no)=>{server.once('error',no);server.listen(port,host,ok);});if(options.origin===undefined)app.setOrigin('http://127.0.0.1:'+server.address().port);sourceTask=gateway.start?.();timer=setInterval(()=>{void app.tick().catch(()=>{});},500);timer.unref();return options.origin??app.auth.origin;},async close(){clearInterval(timer);await app.close();await new Promise(ok=>{server.close(ok);server.closeIdleConnections();});await sourceTask;}};
}
