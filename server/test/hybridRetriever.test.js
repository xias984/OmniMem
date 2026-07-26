import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hybridRetrieve } from '../src/retrieval/hybridRetriever.js';
import { loadConfig } from '../src/config.js';
import { chunkId } from '../src/ids.js';

const scoring = loadConfig({}).scoring;

function fakeVectorDeps(chunks) {
  return {
    embed: async () => [[1, 0, 0]],
    collection: {
      async query() {
        return {
          documents: [chunks.map((c) => c.text)],
          distances: [chunks.map((c) => c.distance ?? 0.1)],
          metadatas: [chunks.map((c) => c.metadata ?? {})],
          ids: [chunks.map((c) => c.id)],
        };
      },
    },
  };
}

test('query semantica usa solo il vettoriale (nessuna chiamata al grafo)', async () => {
  let graphCalled = false;
  const graphRepo = {
    async findEntitiesByAlias() { graphCalled = true; return []; },
    async expandFromChunks() { graphCalled = true; return { nodes: [], edges: [] }; },
    async expandFromEntities() { graphCalled = true; return { nodes: [], edges: [] }; },
  };
  const result = await hybridRetrieve(
    { queryText: 'Quale tecnologia è usata dal progetto?', namespace: 'ns', k: 3 },
    { vector: fakeVectorDeps([{ id: 'c1', text: 'Unity WebGL' }]), graphRepo, graphEnabled: true, graphRetrieval: { maxHops: 2 }, scoring }
  );
  assert.equal(result.usedGraph, false);
  assert.equal(graphCalled, false);
  assert.equal(result.results.length, 1);
});

test('query decisionale usa il grafo quando disponibile', async () => {
  const graphRepo = {
    async findEntitiesByAlias() { return []; },
    async expandFromChunks() { return { nodes: [], edges: [] }; },
    async expandFromEntities() { return { nodes: [], edges: [] }; },
  };
  const result = await hybridRetrieve(
    { queryText: 'Quale decisione ha sostituito quella vecchia?', namespace: 'ns', k: 3 },
    { vector: fakeVectorDeps([{ id: 'c1', text: 'x' }]), graphRepo, graphEnabled: true, graphRetrieval: { maxHops: 2 }, scoring }
  );
  assert.equal(result.usedGraph, true);
  assert.equal(result.category, 'decision');
});

test('fallback sicuro al vettoriale se il grafo non e abilitato', async () => {
  const result = await hybridRetrieve(
    { queryText: 'Quali problemi bloccano il progetto?', namespace: 'ns', k: 3 },
    { vector: fakeVectorDeps([{ id: 'c1', text: 'x' }]), graphRepo: null, graphEnabled: false, graphRetrieval: { maxHops: 2 }, scoring }
  );
  assert.equal(result.usedGraph, false);
  assert.equal(result.fallbackToVector, false); // disabilitato di proposito, non e' un fallimento
  assert.equal(result.results.length, 1);
});

test('fallback sicuro al vettoriale se il grafo lancia un errore', async () => {
  const graphRepo = {
    async findEntitiesByAlias() { throw new Error('Neo4j giu'); },
    async expandFromChunks() { throw new Error('Neo4j giu'); },
    async expandFromEntities() { throw new Error('Neo4j giu'); },
  };
  const result = await hybridRetrieve(
    { queryText: 'Da quali task dipende questa attività?', namespace: 'ns', k: 3 },
    { vector: fakeVectorDeps([{ id: 'c1', text: 'x' }]), graphRepo, graphEnabled: true, graphRetrieval: { maxHops: 2 }, scoring, logger: { error() {} } }
  );
  assert.equal(result.fallbackToVector, true);
  assert.equal(result.results.length, 1);
});

test('deduplica un chunk trovato sia dal vettoriale sia dall espansione grafo', async () => {
  const cid = chunkId('ns', 'c1');
  const graphRepo = {
    async findEntitiesByAlias() { return []; },
    async expandFromChunks() {
      return {
        nodes: [{ id: cid, name: 'c1', summary: 'testo', __labels: ['Chunk'], hop: 0, metadata: { chroma_id: 'c1' } }],
        edges: [],
      };
    },
    async expandFromEntities() { return { nodes: [], edges: [] }; },
  };
  const result = await hybridRetrieve(
    { queryText: 'Quali decisioni non sono più valide?', namespace: 'ns', k: 3 },
    { vector: fakeVectorDeps([{ id: 'c1', text: 'x' }]), graphRepo, graphEnabled: true, graphRetrieval: { maxHops: 2 }, scoring }
  );
  const occurrences = result.results.filter((r) => r.id === 'c1');
  assert.equal(occurrences.length, 1);
  assert.match(occurrences[0].source, /vector/);
  assert.match(occurrences[0].source, /graph/);
});

test('i risultati sono ordinati per punteggio decrescente', async () => {
  const graphRepo = {
    async findEntitiesByAlias() { return []; },
    async expandFromChunks() { return { nodes: [], edges: [] }; },
    async expandFromEntities() { return { nodes: [], edges: [] }; },
  };
  const result = await hybridRetrieve(
    { queryText: 'Esistono memorie in contraddizione?', namespace: 'ns', k: 3 },
    {
      vector: fakeVectorDeps([
        { id: 'c1', text: 'a', distance: 0.5 },
        { id: 'c2', text: 'b', distance: 0.1 },
      ]),
      graphRepo, graphEnabled: true, graphRetrieval: { maxHops: 2 }, scoring,
    }
  );
  const scores = result.results.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});
