import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../src/observability/metrics.js';

test('increment accumula i contatori per nome', () => {
  const m = new MetricsCollector({ log() {} });
  m.increment('entities_extracted');
  m.increment('entities_extracted', 3);
  assert.equal(m.snapshot().counters.entities_extracted, 4);
});

test('recordDuration calcola media e massimo', () => {
  const m = new MetricsCollector({ log() {} });
  m.recordDuration('vector_retrieval_duration', 10);
  m.recordDuration('vector_retrieval_duration', 30);
  const snap = m.snapshot().durations.vector_retrieval_duration;
  assert.equal(snap.count, 2);
  assert.equal(snap.avgMs, 20);
  assert.equal(snap.maxMs, 30);
});

test('time() cronometra una funzione async e registra la durata anche se lancia', async () => {
  const m = new MetricsCollector({ log() {} });
  await m.time('graph_retrieval_duration', async () => 'ok');
  await assert.rejects(() => m.time('graph_retrieval_duration', async () => { throw new Error('boom'); }));
  assert.equal(m.snapshot().durations.graph_retrieval_duration.count, 2);
});

test('snapshot non contiene mai il testo delle query/contenuti, solo numeri', () => {
  const m = new MetricsCollector({ log() {} });
  m.increment('retrieved_chunks', 5);
  const snap = m.snapshot();
  const serialized = JSON.stringify(snap);
  assert.doesNotMatch(serialized, /[a-zA-Z]{20,}/); // nessuna stringa lunga tipo testo libero
});
