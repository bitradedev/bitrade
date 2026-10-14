import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAIHealth } from '../ai-health.mjs';

test('AI diagnostics retain bounded timing samples, omit payloads and roll totals by UTC day', () => {
  let saved;
  const store = {
    get: () => saved,
    put: (_table, value) => {
      saved = value;
    },
  };
  const at = Date.parse('2026-10-15T00:00:00Z');
  for (let i = 0; i < 20; i++)
    recordAIHealth(store, {
      at: at + i,
      durationMs: 90000,
      contextBytes: 1024,
      ok: i % 2 === 0,
      code: 'AI_TIMEOUT',
      networkCode: null,
      httpStatus: null,
      prompt: 'private prompt',
      response: 'private response',
      apiKey: 'private key',
    });
  assert.equal(saved.successes, 10);
  assert.equal(saved.failures, 10);
  assert.equal(saved.recent.length, 16);
  assert.equal(saved.recent[0].at, at + 4);
  assert.doesNotMatch(JSON.stringify(saved), /private|prompt|response|apiKey/);
  recordAIHealth(store, { at: at + 86400000, ok: true, durationMs: 5000, contextBytes: 1234 });
  assert.equal(saved.day, '2026-10-16');
  assert.equal(saved.successes, 1);
  assert.equal(saved.failures, 0);
  assert.equal(saved.recent.length, 1);
});
