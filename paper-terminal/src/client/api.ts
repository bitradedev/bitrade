import type { AppState, Candle } from '../shared/domain';
import { extractError } from './lib';

export async function request<T>(path: string, csrf?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(extractError(payload, `请求失败（${response.status}）`));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const readState = (signal?: AbortSignal) => request<AppState>('/api/state', undefined, undefined, signal);
export const readCandles = (chain: string, token: string, signal?: AbortSignal) => request<{ candles: Candle[] } & Record<string, unknown>>(`/api/candles?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}`, undefined, undefined, signal);
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function backupDatabase(csrf: string) {
  const response = await fetch('/api/backup', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' });
  if (!response.ok) throw new Error(extractError(await response.json().catch(() => null), `备份失败（${response.status}）`));
  downloadBlob(await response.blob(), `paper-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
}
export async function exportCsv(kind: 'fills' | 'orders' | 'positions') {
  const response = await fetch(`/api/export?kind=${kind}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(extractError(await response.json().catch(() => null), '导出失败。'));
  downloadBlob(await response.blob(), `${kind}-${new Date().toISOString().slice(0, 10)}.csv`);
}
export const MAX_RESTORE_BYTES = 8 * 1024 * 1024 * 1024;
export async function restoreDatabase(file: File, csrf: string): Promise<void> {
  if (!file.size) throw new Error('备份文件为空，请选择完整备份。');
  if (file.size > MAX_RESTORE_BYTES) throw new Error('网页恢复最大支持 8GB。请保留备份，更大的历史记录需要迁移完整数据文件夹。');
  const response = await fetch('/api/restore', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/vnd.sqlite3', 'X-CSRF-Token': csrf }, body: file });
  if (!response.ok) throw new Error(extractError(await response.json().catch(() => null), `恢复失败（${response.status}）`));
  const result = await response.json();
  if (result.restored !== true) throw new Error('后台尚未确认恢复成功，请重新读取模拟账本。');
}
