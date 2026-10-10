import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { accounts } from './dependencies.mjs';
export class EncryptedVault {
  constructor(key) {
    this.key = Buffer.from(key);
    if (this.key.length !== 32) throw Error('钱包加密密钥须为32字节Base64');
  }
  encrypt(secret, context) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }
  decrypt(value, context) {
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    d.setAAD(Buffer.from(context));
    d.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(value.data, 'base64')), d.final()]).toString('utf8');
  }
  create(id) {
    const key = accounts.generatePrivateKey(),
      account = accounts.privateKeyToAccount(key);
    return {
      address: account.address.toLowerCase(),
      encryptedKey: this.encrypt(key, 'agent-key:' + id),
    };
  }
  account(agent) {
    return accounts.privateKeyToAccount(this.decrypt(agent.encryptedKey, 'agent-key:' + agent.id));
  }
}
