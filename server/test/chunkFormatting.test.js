import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAndFormatChunks } from '../src/retrieval/chunkFormatting.js';

test('raggruppa i chunk per source_url invece di mescolare conversazioni diverse', () => {
  const out = groupAndFormatChunks([
    { doc: 'a1', meta: { source_url: 'https://a', timestamp: 2, platform: 'ChatGPT' }, sortValue: 0.1 },
    { doc: 'b1', meta: { source_url: 'https://b', timestamp: 1, platform: 'Claude' }, sortValue: 0.2 },
    { doc: 'a2', meta: { source_url: 'https://a', timestamp: 1, platform: 'ChatGPT' }, sortValue: 0.1 },
  ]);
  // Il gruppo "https://a" ha sortValue medio migliore (0.1) e deve uscire per primo,
  // con i suoi due chunk in ordine cronologico (a2 prima di a1).
  assert.match(out[0], /a2/);
  assert.match(out[1], /a1/);
  assert.match(out[2], /b1/);
});

test('ordina i gruppi per sortValue medio crescente (piu basso = migliore)', () => {
  const out = groupAndFormatChunks([
    { doc: 'peggiore', meta: { source_url: 'https://worse', timestamp: 1 }, sortValue: 0.9 },
    { doc: 'migliore', meta: { source_url: 'https://better', timestamp: 1 }, sortValue: 0.1 },
  ]);
  assert.match(out[0], /migliore/);
  assert.match(out[1], /peggiore/);
});

test('funziona con sortValue derivato da uno score ibrido (1 - score)', () => {
  const results = [
    { text: 'basso punteggio', metadata: { source_url: 'https://x', timestamp: 1 }, score: 0.2 },
    { text: 'alto punteggio', metadata: { source_url: 'https://y', timestamp: 1 }, score: 0.9 },
  ];
  const out = groupAndFormatChunks(results.map((r) => ({ doc: r.text, meta: r.metadata, sortValue: 1 - r.score })));
  assert.match(out[0], /alto punteggio/);
  assert.match(out[1], /basso punteggio/);
});

test('include data e fonte nell header, coerente col formato esistente', () => {
  const out = groupAndFormatChunks([
    { doc: 'testo', meta: { source_url: 'https://x', platform: 'ChatGPT', timestamp: Date.parse('2026-01-15') }, sortValue: 0.1 },
  ]);
  assert.match(out[0], /\[ChatGPT — 2026-01-15 — https:\/\/x\]\ntesto/);
});

test('usa file_path al posto di source_url quando disponibile (ingestion codebase)', () => {
  const out = groupAndFormatChunks([
    { doc: 'codice', meta: { source_url: 'file:///x', file_path: 'src/index.js', platform: 'codebase', timestamp: 1 }, sortValue: 0.1 },
  ]);
  assert.match(out[0], /src\/index\.js/);
});

test('non esplode con metadata mancanti', () => {
  const out = groupAndFormatChunks([{ doc: 'x', meta: {}, sortValue: 0.5 }]);
  assert.equal(out.length, 1);
  assert.match(out[0], /\[\? — \?\]\nx/);
});
