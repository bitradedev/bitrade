// Merge a private local snapshot without deleting newly created cloud accounts.
export function mergeLedger(store, vault, input, digest) {
  if (
    input.version !== 1 ||
    !Array.isArray(input.entities) ||
    !Array.isArray(input.intents) ||
    !Array.isArray(input.audit)
  )
    throw Error('Invalid snapshot');
  const builtins = new Set();
  for (const row of input.entities) {
    if (
      typeof row.kind !== 'string' ||
      typeof row.id !== 'string' ||
      typeof row.payload !== 'string'
    )
      throw Error('Invalid snapshot');
    const value = JSON.parse(row.payload);
    if (value.id !== row.id) throw Error('Invalid snapshot');
    if (row.kind === 'agents') {
      if (vault.account(value).address.toLowerCase() !== value.address)
        throw Error('Vault mismatch');
      if (value.source === 'builtin') builtins.add(value.id);
      else if (store.get('agents', value.id)) throw Error('Agent collision');
    }
  }
  return store.transaction(() => {
    if (store.all('paper-fills').some((f) => builtins.has(f.agentId)))
      throw Error('Cloud showcase already has fills');
    // These are only the unused placeholder showcase accounts, never user data.
    for (const kind of [
      'agents',
      'paper-accounts',
      'paper-ledger',
      'paper-lots',
      'paper-orders',
      'requests',
      'showcase-status',
      'showcase-exits',
    ])
      for (const value of store.all(kind)) {
        if (builtins.has(value.agentId ?? value.id))
          store.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, value.id);
      }
    for (const row of input.entities) {
      const value = JSON.parse(row.payload),
        old = store.get(row.kind, row.id);
      if (row.kind === 'token-risk-reports' && old?.fetchedAt > value.fetchedAt) continue;
      store.put(row.kind, value);
    }
    for (const row of input.intents) {
      const old = store.db
        .prepare('SELECT signature,id FROM intents WHERE agent=? AND requestKey=?')
        .get(row.agent, row.requestKey);
      if (old && (old.signature !== row.signature || old.id !== row.id))
        throw Error('Intent collision');
      if (!old)
        store.db
          .prepare('INSERT INTO intents VALUES(?,?,?,?)')
          .run(row.agent, row.requestKey, row.signature, row.id);
    }
    for (const row of input.audit)
      store.db
        .prepare('INSERT INTO audit(at,owner,agent,kind,message) VALUES(?,?,?,?,?)')
        .run(row.at, row.owner, row.agent, row.kind, row.message);
    store.put('cloud-settings', {
      id: 'imported',
      at: Date.now(),
      entities: input.entities.length,
      digest,
    });
    return { imported: true, entities: input.entities.length };
  });
}
