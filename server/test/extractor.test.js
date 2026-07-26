import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OllamaExtractor, NullExtractor } from '../src/graph/extractor/extractor.js';
import { ENTITY_TYPES } from '../src/graph/extractor/schema.js';
import { RELATION_TYPES, DECISION_STATUSES } from '../src/graph/schema.js';

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function mockOllamaResponse(responseText) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ response: responseText }),
  });
}

function newExtractor(overrides = {}) {
  return new OllamaExtractor({
    baseUrl: 'http://fake-ollama',
    model: 'test-model',
    maxRetries: 1,
    timeoutMs: 1000,
    entityTypes: ENTITY_TYPES,
    relationTypes: RELATION_TYPES,
    decisionStatuses: DECISION_STATUSES,
    logger: { error: () => {} },
    ...overrides,
  });
}

test('NullExtractor ritorna sempre struttura vuota senza chiamate di rete', async () => {
  const extractor = new NullExtractor();
  const result = await extractor.extract([{ id: 'chunk_1', text: 'ciao' }], { namespace: 'ns' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { entities: [], relations: [], decisions: [] });
});

test('OllamaExtractor valida e ritorna output ben formato', async () => {
  mockOllamaResponse(JSON.stringify({
    entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: [] }],
    relations: [{ source: 'Hearthfall', relationship: 'USES', target: 'Unity WebGL', description: '', confidence: 0.9, evidence_chunk_id: 'chunk_1' }],
    decisions: [],
  }));
  const extractor = newExtractor();
  const result = await extractor.extract([{ id: 'chunk_1', text: 'Hearthfall usa Unity WebGL' }], { namespace: 'ns' });
  assert.equal(result.ok, true);
  assert.equal(result.data.relations.length, 1);
});

test('OllamaExtractor estrae il JSON anche se avvolto in un blocco markdown', async () => {
  mockOllamaResponse('Ecco il risultato:\n```json\n{"entities":[],"relations":[],"decisions":[]}\n```');
  const extractor = newExtractor();
  const result = await extractor.extract([{ id: 'chunk_1', text: 'x' }], { namespace: 'ns' });
  assert.equal(result.ok, true);
});

test('OllamaExtractor scarta interamente output con JSON malformato dopo i retry (nessun salvataggio parziale)', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ response: '{not valid json' }) };
  };
  const extractor = newExtractor({ maxRetries: 2 });
  const result = await extractor.extract([{ id: 'chunk_1', text: 'x' }], { namespace: 'ns' });
  assert.equal(result.ok, false);
  assert.equal(calls, 3); // tentativo iniziale + 2 retry, limitati
});

test('OllamaExtractor rifiuta relazioni con evidence_chunk_id non presente nei chunk passati', async () => {
  mockOllamaResponse(JSON.stringify({
    entities: [],
    relations: [{ source: 'a', relationship: 'USES', target: 'b', description: '', confidence: 0.8, evidence_chunk_id: 'chunk_INVENTATO' }],
    decisions: [],
  }));
  const extractor = newExtractor({ maxRetries: 0 });
  const result = await extractor.extract([{ id: 'chunk_1', text: 'x' }], { namespace: 'ns' });
  assert.equal(result.ok, false);
});

test('OllamaExtractor rispetta il timeout configurato', async () => {
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const extractor = newExtractor({ maxRetries: 0, timeoutMs: 50 });
  const result = await extractor.extract([{ id: 'chunk_1', text: 'x' }], { namespace: 'ns' });
  assert.equal(result.ok, false);
});

test('extract con lista chunk vuota non chiama il modello', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ response: '{}' }) }; };
  const extractor = newExtractor();
  const result = await extractor.extract([], { namespace: 'ns' });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});
