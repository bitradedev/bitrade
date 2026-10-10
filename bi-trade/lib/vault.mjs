import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EncryptedVault } from './vault-core.mjs';
export class WalletVault extends EncryptedVault {
  constructor(directory, { key, production = false, existingWallets = false } = {}) {
    let vaultKey;
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, 'vault-key');
    if (!key && production) throw Error('公开部署须配置独立的BI_TRADE_VAULT_KEY');
    if (existingWallets && !key && !existsSync(path))
      throw Error('账本中已有钱包，但加密密钥缺失；请恢复原密钥');
    if (key) vaultKey = Buffer.from(key, 'base64');
    else if (existsSync(path)) vaultKey = readFileSync(path);
    else {
      vaultKey = randomBytes(32);
      writeFileSync(path, vaultKey, { flag: 'wx', mode: 0o600 });
    }
    super(vaultKey);
  }
}
