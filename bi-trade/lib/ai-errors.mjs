import { fail } from './database-core.mjs';

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
function networkCode(error) {
  for (const e of [error, error?.cause, ...(error?.cause?.errors ?? []).slice(0, 6)])
    if (NETWORK_CODES.has(e?.code)) return e.code;
  return null;
}
export function aiRequestFailure(error, { cancelled = false } = {}) {
  const transportCode = networkCode(error);
  const timeout = error?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(transportCode ?? '');
  const code = cancelled
    ? 'AI_CANCELLED'
    : timeout
      ? 'AI_TIMEOUT'
      : ['ENOTFOUND', 'EAI_AGAIN'].includes(transportCode)
        ? 'AI_DNS'
        : /CERT|TLS|SIGNATURE/.test(transportCode ?? '')
          ? 'AI_TLS'
          : 'AI_CONNECTION';
  return Object.assign(
    fail(
      cancelled
        ? '本轮评估已中止。'
        : timeout
          ? 'AI 服务响应较慢，本轮未生成决策，稍后自动重试。'
          : 'AI 服务连接暂时不稳定，本轮未生成决策，稍后自动重试。',
      503,
    ),
    {
      code,
      aiDiagnostic: { code, networkCode: transportCode, httpStatus: null },
      retryable: !cancelled,
    },
  );
}
export function aiHttpFailure(status, { retryAt = null } = {}) {
  const code =
    status === 429
      ? 'AI_RATE_LIMITED'
      : [401, 403].includes(status)
        ? 'AI_AUTH'
        : status >= 500
          ? 'AI_PROVIDER'
          : 'AI_RESPONSE';
  return Object.assign(
    fail(
      code === 'AI_AUTH'
        ? 'AI 服务配置需要维护，本轮暂停评估。'
        : 'AI 服务暂时繁忙，本轮未生成决策，稍后自动重试。',
      503,
    ),
    {
      code,
      aiDiagnostic: { code, networkCode: null, httpStatus: status },
      retryable: code !== 'AI_AUTH',
      retryAt: code !== 'AI_AUTH' && Number.isFinite(retryAt) && retryAt > 0 ? retryAt : null,
    },
  );
}
