// Instance-local repository reuse. Evidence still expires after one second;
// ledger rows may be reused until a known mutation invalidates their kind.
// Every caller receives an independent copy with original evidence times.
export class EntityReads {
  constructor({ now = Date.now, ttl = 1000, maxEntries = 256, maxCharacters = 1000000 } = {}) {
    Object.assign(this, { now, ttl, maxEntries, maxCharacters });
    this.entries = new Map();
    this.characters = 0;
  }
  remove(key) {
    const old = this.entries.get(key);
    if (old) this.characters -= key.length + old.payload.length;
    this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
    this.characters = 0;
  }
  invalidate(kind, id) {
    for (const key of this.entries.keys()) {
      const parts = JSON.parse(key);
      if (parts[1] === kind && (parts[0] !== 'get' || id === undefined || parts[2] === id))
        this.remove(key);
    }
  }
  read(key, load, { ledger = false } = {}) {
    const at = this.now(),
      old = this.entries.get(key);
    if (old && at >= old.at && (ledger || at - old.at < this.ttl)) return JSON.parse(old.payload);
    this.remove(key);
    const value = load(),
      payload = JSON.stringify(value);
    if (typeof payload !== 'string') return value;
    const size = key.length + payload.length;
    if (size > this.maxCharacters || this.maxEntries < 1 || this.ttl <= 0) return value;
    while (this.entries.size >= this.maxEntries || this.characters + size > this.maxCharacters)
      this.remove(this.entries.keys().next().value);
    this.entries.set(key, { at, payload });
    this.characters += size;
    return value;
  }
}
