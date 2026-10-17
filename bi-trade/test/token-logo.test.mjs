import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenLogo} from '../lib/token-logo.mjs';

test('token logos retain original HTTPS images and resolve public IPFS identifiers',()=>{
 assert.equal(tokenLogo('https://cdn.example.org/covenant.png?size=64'),'https://cdn.example.org/covenant.png?size=64');
 const cid='Qm'+'a'.repeat(44);
 assert.equal(tokenLogo('ipfs://'+cid+'/avatar.png'),'https://ipfs.io/ipfs/'+cid+'/avatar.png');
 assert.equal(tokenLogo('ipfs://ipfs/'+cid),'https://ipfs.io/ipfs/'+cid);
 for(const value of [null,'','/private-avatar','javascript:alert(1)','data:image/svg+xml,test','http://cdn.example.org/a.png','https://user:secret@cdn.example.org/a.png','https://localhost/a.png','https://127.0.0.1/a.png','https://[::1]/a.png','https://service.internal/a.png','https://cdn.example.org:8889/a.png','https://cdn.example.org/a\n.png','ipfs://invalid']) assert.equal(tokenLogo(value),null,String(value));
});
