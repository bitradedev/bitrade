import { canonicalJson, digest } from '../bi-trade/lib/database-core.mjs';
import { SHOWCASE_PROFILES } from '../bi-trade/lib/showcase-agents-core.mjs';

// Operator-only, one-use deployment setting. No browser or Agent reset API.
export function resetShowcasePaper(store, operationId, now = Date.now()) {
  if (!operationId) return null;
  if (!/^showcase-paper-[a-z0-9-]{1,80}$/.test(operationId))
    throw Error('Invalid showcase reset operation');
  const markerId = 'showcase-reset:' + operationId;
  return store.transaction(() => {
    const completed = store.get('cloud-settings', markerId);
    if (completed) return completed;
    const agentIds = SHOWCASE_PROFILES.map((p) => p.id);
    for (const id of agentIds) {
      const a = store.get('agents', id);
      if (a?.source !== 'builtin' || a.ownerId !== 'platform-showcase' || a.mode !== 'paper')
        throw Error('Showcase reset refused: scope is not three builtin paper Agents');
    }
    const counts = {},
      archived = [];
    for (const kind of [
      'paper-accounts',
      'paper-orders',
      'paper-fills',
      'paper-lots',
      'paper-ledger',
      'showcase-status',
      'showcase-exits',
    ]) {
      const rows = store
        .all(kind)
        .filter((v) =>
          agentIds.includes(
            ['paper-accounts', 'showcase-status'].includes(kind) ? v.id : v.agentId,
          ),
        );
      counts[kind] = rows.length;
      for (const value of rows) {
        const fingerprint = digest(canonicalJson(value));
        store.put('paper-reset-archives', {
          id: digest(operationId + ':' + kind + ':' + value.id),
          operationId,
          entityKind: kind,
          entityId: value.id,
          agentId: value.agentId ?? value.id,
          archivedAt: now,
          fingerprint,
          value,
        });
        archived.push([kind, value.id, fingerprint]);
        store.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, value.id);
      }
    }
    for (const id of agentIds)
      store.put('paper-accounts', {
        id,
        initialUsd: 1000,
        nativeRaw: null,
        realizedNativeRaw: '0',
        realizedUsd: 0,
        feesUsd: 0,
        createdAt: now,
        resetId: operationId,
      });
    const marker = {
      id: markerId,
      operationId,
      completedAt: now,
      agentIds,
      initialUsd: 1000,
      archivedCounts: counts,
      archiveFingerprint: digest(canonicalJson(archived)),
    };
    store.put('cloud-settings', marker);
    store.put('cloud-settings', { ...marker, id: 'showcase-paper-reset' });
    store.audit('platform-showcase', null, 'showcase-paper-reset', JSON.stringify(marker));
    return marker;
  });
}
