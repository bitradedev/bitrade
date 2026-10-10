import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PlatformStore} from './lib/database.mjs';
import {WalletVault} from './lib/vault.mjs';
import {saveAIConfig} from './lib/ai-provider.mjs';
const dir=resolve(process.env.BI_TRADE_DATA_DIR??resolve(dirname(fileURLToPath(import.meta.url)),'data'));
let store;
try{
 let input='';for await(const part of process.stdin){input+=part;if(input.length>4096)throw Error();}
 store=new PlatformStore(dir);const vault=new WalletVault(dir,{key:process.env.BI_TRADE_VAULT_KEY,production:process.env.NODE_ENV==='production',existingWallets:store.all('agents').length>0});
 for(const a of store.all('agents'))if(vault.account(a).address.toLowerCase()!==a.address)throw Error();
 console.log(JSON.stringify(saveAIConfig(store,vault,JSON.parse(input))));
}catch{console.error('配置未保存，请核对密钥、模型名称和本机加密密钥。');process.exitCode=1;}finally{store?.close();}
