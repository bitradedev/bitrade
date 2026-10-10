import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {accounts} from './dependencies.mjs';
export class WalletVault{
 constructor(directory,{key,production=false,existingWallets=false}={}){
  mkdirSync(directory,{recursive:true});const path=resolve(directory,'vault-key');
  if(!key&&production)throw Error('公开部署须配置独立的BI_TRADE_VAULT_KEY');
  if(existingWallets&&!key&&!existsSync(path))throw Error('账本中已有钱包，但加密密钥缺失；请恢复原密钥');
  if(key)this.key=Buffer.from(key,'base64');else if(existsSync(path))this.key=readFileSync(path);else{this.key=randomBytes(32);writeFileSync(path,this.key,{flag:'wx',mode:0o600});}
  if(this.key.length!==32)throw Error('钱包加密密钥须为32字节Base64');
 }
 encrypt(secret,context){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(context));const data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
 decrypt(value,context){const d=createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.iv,'base64'));d.setAAD(Buffer.from(context));d.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([d.update(Buffer.from(value.data,'base64')),d.final()]).toString('utf8');}
 create(id){const key=accounts.generatePrivateKey(),account=accounts.privateKeyToAccount(key);return {address:account.address.toLowerCase(),encryptedKey:this.encrypt(key,'agent-key:'+id)};}
 account(agent){return accounts.privateKeyToAccount(this.decrypt(agent.encryptedKey,'agent-key:'+agent.id));}
}
