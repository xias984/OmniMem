import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorRetrieve } from '../src/retrieval/vectorRetriever.js';

function fakeDeps({ ids, docs, distances, metas }) {
  let seenQuery = null;
  return {
    embed: async () => [[1, 0, 0]],
    collection: {
      async query(q) {
        seenQuery = q;
        return { ids: [ids], documents: [docs], distances: [distances], metadatas: [metas] };
      },
    },
    getSeenQuery: () => seenQuery,
  };
}

test('usa k=12 e soglia 0.85 di default, coerenti con /api/query', async () => {
  const deps = fakeDeps({ ids: ['c1'], docs: ['x'], distances: [0.5], metas: [{}] });
  await vectorRetrieve({ queryText: 'ciao', namespace: 'ns' }, deps);
  assert.equal(deps.getSeenQuery().nResults, 12);
});

test('filtra i risultati sopra la soglia di distanza', async () => {
  const deps = fakeDeps({ ids: ['c1', 'c2'], docs: ['a', 'b'], distances: [0.5, 0.9], metas: [{}, {}] });
  const results = await vectorRetrieve({ queryText: 'x', namespace: 'ns' }, deps);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'c1');
});

test('ordina per similarita decrescente', async () => {
  const deps = fakeDeps({ ids: ['c1', 'c2'], docs: ['a', 'b'], distances: [0.6, 0.1], metas: [{}, {}] });
  const results = await vectorRetrieve({ queryText: 'x', namespace: 'ns' }, deps);
  assert.deepEqual(results.map((r) => r.id), ['c2', 'c1']);
});

test('applica il filtro namespace/topic tranne per "Generale"', async () => {
  const deps = fakeDeps({ ids: [], docs: [], distances: [], metas: [] });
  await vectorRetrieve({ queryText: 'x', namespace: 'Hearthfall' }, deps);
  assert.deepEqual(deps.getSeenQuery().where, { topic: { $eq: 'Hearthfall' } });

  await vectorRetrieve({ queryText: 'x', namespace: 'Generale' }, deps);
  assert.equal(deps.getSeenQuery().where, undefined);
});
