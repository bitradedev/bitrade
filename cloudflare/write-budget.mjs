// Conservative per-object guard. Cloudflare's account-wide quota is authoritative.
// Latch protection only between completed operations, never inside a ledger transaction.
export class StorageWriteBudget {
  constructor(saved = null, { now = Date.now, limit = 80000 } = {}) {
    this.now = now;
    this.limit = limit;
    this.day = '';
    this.rows = 0;
    this.roll();
    if (saved?.day === this.day && Number.isSafeInteger(saved.rows) && saved.rows >= 0)
      this.rows = saved.rows;
  }
  roll() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      this.rows = 0;
      return true;
    }
    return false;
  }
  record(rows) {
    this.roll();
    if (Number.isSafeInteger(rows) && rows > 0) this.rows += rows;
  }
  snapshot() {
    this.roll();
    return {
      day: this.day,
      rows: this.rows,
      limit: this.limit,
      scope: 'platform-object-estimate',
      retryAt: this.rows >= this.limit ? Date.parse(this.day + 'T00:00:00Z') + 86400000 : null,
    };
  }
}
