import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PlatformRepository, canonicalJson, digest } from '../../bi-trade/lib/database-core.mjs';
import { resetShowcasePaper } from '../showcase-reset.mjs';

const IDS = ['showcase-trend', 'showcase-rebound', 'showcase-rotation'];
const OP = 'showcase-paper-20261011-user-reset-1';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new PlatformRepository(db, fn => {
    db.exec('BEGIN');try {const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}
  });
  for (const id of [...IDS,'user-agent']) {
    store.put('agents', {id, ownerId: IDS.includes(id)?'platform-showcase':'owner', source: IDS.includes(id)?'builtin':'user', mode:'paper', address:id, encryptedKey:'retained'});
    for (const kind of ['paper-accounts','paper-orders','paper-fills','paper-lots','paper-ledger','showcase-status','showcase-exits'])
      store.put(kind,{id:['paper-accounts','showcase-status'].includes(kind)?id:kind+':'+id, agentId:id, nativeRaw:'10', initialUsd:1000, remainingRaw:'8', feesUsd:7, realizedUsd:-25});
  }
  store.put('token-risk',{id:'risk',state:'unknown'});
  store.put('cloud-settings',{id:'gmgn-budget',cooldown:9999999,spacing:15000});
  store.put('ai-usage',{id:'keep',calls:12});
  db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?)').run('secret-hash','owner','owner',null,9999999999999,'csrf');
  return store;
}
test('Operator reset archives all three builtin ledgers atomically and preserves user accounts, credentials and provider/risk records',t=>{
  const store=fixture(t),before=store.db.prepare('SELECT * FROM entities ORDER BY kind,id').all(),credentials=store.db.prepare('SELECT * FROM credentials').all();
  const marker=resetShowcasePaper(store,OP,1234);assert.deepEqual(marker.agentIds,IDS);assert.equal(marker.initialUsd,1000);
  for(const id of IDS){const a=store.get('paper-accounts',id);assert.equal(a.initialUsd,1000);assert.equal(a.nativeRaw,null);assert.equal(a.realizedUsd,0);assert.equal(a.realizedNativeRaw,'0');assert.equal(a.feesUsd,0);assert.equal(a.resetId,OP);}
  const archives=store.all('paper-reset-archives');assert.equal(archives.length,21);
  for(const row of before){const value=JSON.parse(row.payload);if(row.kind!=='agents'&&IDS.includes(value.agentId)){
    const saved=archives.find(a=>a.entityKind===row.kind&&a.entityId===row.id);assert.deepEqual(saved.value,value);assert.equal(saved.fingerprint,digest(canonicalJson(value)));
    if(row.kind!=='paper-accounts')assert.equal(store.get(row.kind,row.id),null);
  }else assert.equal(canonicalJson(store.get(row.kind,row.id)),canonicalJson(value));}
  assert.deepEqual(store.db.prepare('SELECT * FROM credentials').all(),credentials);
  assert.equal(store.get('cloud-settings','gmgn-budget').cooldown,9999999);
  assert.equal(store.all('paper-fills').length,1);assert.equal(store.all('paper-fills')[0].agentId,'user-agent');
  assert.equal(store.get('cloud-settings','showcase-paper-reset').operationId,OP);
  assert.equal(store.db.prepare('SELECT kind FROM audit').get().kind,'showcase-paper-reset');
});
test('The same reset deployment cannot erase new fills or new losses on reconstruction',t=>{
  const store=fixture(t),first=resetShowcasePaper(store,OP,1234);
  store.put('paper-fills',{id:'new-fill',agentId:IDS[0],netUsd:-2});
  store.put('paper-accounts',{...store.get('paper-accounts',IDS[0]),nativeRaw:'5',realizedUsd:-2});
  assert.deepEqual(resetShowcasePaper(store,OP,5678),first);assert.equal(store.get('paper-fills','new-fill').netUsd,-2);assert.equal(store.get('paper-accounts',IDS[0]).realizedUsd,-2);assert.equal(store.all('paper-reset-archives').length,21);
  assert.equal(resetShowcasePaper(store,null),null);
});
test('Failed archival rolls back financial deletion, new capital, reset marker and audit',t=>{
  const store=fixture(t),before=store.db.prepare('SELECT * FROM entities ORDER BY kind,id').all(),put=store.put.bind(store);let count=0;
  store.put=(kind,value)=>{if(kind==='paper-reset-archives'&&++count===5)throw Error('archive failed');return put(kind,value);};
  assert.throws(()=>resetShowcasePaper(store,OP),/archive failed/);
  assert.deepEqual(store.db.prepare('SELECT * FROM entities ORDER BY kind,id').all(),before);assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get().n,0);
});
test('Reset refuses missing, user-owned, live or conflicting Agent identities before mutation',t=>{
  const store=fixture(t);
  for(const patch of [{source:'user'},{ownerId:'owner'},{mode:'live'}]){
    const old=store.get('agents',IDS[0]);store.put('agents',{...old,...patch});assert.throws(()=>resetShowcasePaper(store,OP),/scope/);assert.equal(store.get('paper-accounts',IDS[0]).realizedUsd,-25);store.put('agents',old);
  }
  store.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run('agents',IDS[0]);assert.throws(()=>resetShowcasePaper(store,OP),/scope/);assert.equal(store.all('paper-reset-archives').length,0);
});
