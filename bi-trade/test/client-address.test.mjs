import test from 'node:test';
import assert from 'node:assert/strict';
import {clientAddress,trustedProxyList} from '../lib/client-address.mjs';
const req=(peer,forwarded)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':forwarded}});
test('untrusted peers cannot spoof a client address using forwarding headers',()=>{
 assert.equal(clientAddress(req('203.0.113.9','198.51.100.4')), '203.0.113.9');
 assert.equal(clientAddress(req('::ffff:127.0.0.1','198.51.100.4')), '127.0.0.1');
});
test('trusted proxy chains select the nearest untrusted hop and reject malformed headers',()=>{
 const trusted=trustedProxyList('127.0.0.1, 192.0.2.2');
 assert.equal(clientAddress(req('::ffff:127.0.0.1','198.51.100.4, 192.0.2.2'),trusted),'198.51.100.4');
 assert.equal(clientAddress(req('127.0.0.1','spoof, 192.0.2.2'),trusted),'127.0.0.1');
 assert.equal(clientAddress(req('127.0.0.1','203.0.113.1, 198.51.100.4'),trusted),'198.51.100.4');
 assert.throws(()=>trustedProxyList('anything'),/invalid/);
});
