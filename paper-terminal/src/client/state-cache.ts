import type { AppState } from '../shared/domain';

type Key = (row: any) => string | number;
const entityKeys: Record<string, Key> = {
  markets: row => row.id, accounts: row => row.id, positions: row => row.id,
  orders: row => row.id, fills: row => row.id, strategies: row => row.id,
  researchRuns: row => row.id, audit: row => row.id, controlActivity: row => row.id,
  chains: row => row.chain, controlWallets: row => `${row.chain}:${row.address}`,
};
// Compare every received JSON field, including unknown metadata and removed properties.
// Output containers are allocated only after a difference is found.
export function shareValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return next;
    return shareArray(previous, next) as T;
  }
  return shareObject(previous as Record<string, unknown>, next as Record<string, unknown>) as T;
}
function shareArray(previous: any[], next: any[], key?: Key): any[] {
  let result: any[] | undefined = previous.length === next.length ? undefined : [];
  let byKey: Map<string | number, any> | undefined;
  for (let i = 0; i < next.length; i++) {
    let old = previous[i];
    if (key && old && key(old) !== key(next[i])) {
      byKey ??= new Map(previous.map(row => [key(row), row]));
      old = byKey.get(key(next[i]));
    } else if (key && !old) {
      byKey ??= new Map(previous.map(row => [key(row), row]));
      old = byKey.get(key(next[i]));
    }
    const shared = shareValue(old, next[i]);
    if (!result && shared !== previous[i]) result = previous.slice(0, i);
    result?.push(shared);
  }
  return result ?? previous;
}
function shareObject(previous: Record<string, unknown>, next: Record<string, unknown>, keys?: Record<string, Key>): Record<string, unknown> {
  const names = Object.keys(next);
  let result: Record<string, unknown> | undefined = Object.keys(previous).length === names.length ? undefined : {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i], old = previous[name], value = next[name];
    const shared = keys?.[name] && Array.isArray(old) && Array.isArray(value) ? shareArray(old, value, keys[name]) : shareValue(old, value);
    if (!result && (!Object.prototype.hasOwnProperty.call(previous, name) || shared !== old)) {
      result = {};
      for (let j = 0; j < i; j++) Object.defineProperty(result, names[j], { value: previous[names[j]], enumerable: true, configurable: true, writable: true });
    }
    if (result) Object.defineProperty(result, name, { value: shared, enumerable: true, configurable: true, writable: true });
  }
  return result ?? previous;
}
export function reconcileState(previous: AppState | null, next: AppState): AppState {
  // A new server generation or backwards chain head must not reuse the old generation.
  if (!previous || previous.csrf !== next.csrf || previous.mode !== next.mode || next.chains.some(chain => {
    const old = previous.chains.find(c => c.chain === chain.chain);
    return old && chain.head < old.head;
  })) return next;
  return shareObject(previous as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, entityKeys) as unknown as AppState;
}
export function createFrameCoalescer<T>(deliver: (value: T) => void, request: (callback: () => void) => number, cancel: (id: number) => void) {
  let frame: number | null = null, queued = false, latest: T;
  return {
    push(value: T) { latest = value; queued = true; if (frame === null) frame = request(() => { frame = null; if (queued) { queued = false; deliver(latest); } }); },
    cancel() { if (frame !== null) cancel(frame); frame = null; queued = false; },
  };
}
export function retainBrowseOrder<T extends { id: string }>(rows: T[], frozenIds: string[] | null): T[] {
  if (!frozenIds) return rows;
  const ranks = new Map(frozenIds.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (ranks.get(a.id) ?? frozenIds.length) - (ranks.get(b.id) ?? frozenIds.length));
}
export function reuseArray<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && next.every((row, i) => row === previous[i]) ? previous : next;
}
