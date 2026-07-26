import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidatePhrases, graphRetrieve } from '../src/retrieval/graphRetriever.js';
import { chunkId } from '../src/ids.js';

test('extractCandidatePhrases genera n-gram rilevanti scartando le stopword', () => {
  const phrases = extractCandidatePhrases('Quale tecnologia usa Hearthfall per il rendering?');
  assert.ok(phrases.includes('hearthfall'));
  assert.ok(!phrases.some((p) => p === 'per' || p === 'il'));
});

test('extractCandidatePhrases rispetta il tetto massimo di candidati', () => {
  const longQuery = Array.from({ length: 50 }, (_, i) => `parola${i}`).join(' ');
  const phrases = extractCandidatePhrases(longQuery, { maxCandidates: 10 });
  assert.ok(phrases.length <= 10);
});

function fakeGraphRepoFactory({ aliasMatches = [], expansionByHopFromChunks = { nodes: [], edges: [] }, expansionFromEntities = { nodes: [], edges: [] } } = {}) {
  return {
    async findEntitiesByAlias(namespace, phrase) {
      return aliasMatches.filter((m) => m.matchesPhrase === phrase);
    },
    async expandFromChunks() { return expansionByHopFromChunks; },
    async expandFromEntities() { return expansionFromEntities; },
  };
}

test('graphRetrieve usa i chunk seed per espandere il grafo e raccoglie evidence', async () => {
  const cid = chunkId('ns', 'chunk_1');
  const graphRepo = fakeGraphRepoFactory({
    expansionByHopFromChunks: {
      nodes: [
        { id: 'entity_unity', name: 'Unity', __labels: ['Entity'], hop: 1, metadata: {} },
        { id: 'chunk_extra', name: 'chunk_extra_id', summary: 'testo aggiuntivo', __labels: ['Chunk'], hop: 1, metadata: { chroma_id: 'chunk_999' } },
      ],
      edges: [{ type: 'MENTIONS', fromId: cid, toId: 'entity_unity', confidence: 0.9, hop: 1 }],
    },
  });

  const result = await graphRetrieve(
    { queryText: 'Cosa usa Hearthfall?', namespace: 'ns', seedChunks: [{ id: 'chunk_1' }] },
    { graphRepo, maxHops: 2 }
  );

  assert.equal(result.entityNodes.length, 1);
  assert.equal(result.evidenceChunkNodes.length, 1);
  assert.equal(result.evidenceChunkNodes[0].metadata.chroma_id, 'chunk_999');
});

test('graphRetrieve risolve le entita citate nella query e le usa come seed aggiuntivi', async () => {
  let expandFromEntitiesCalledWith = null;
  const graphRepo = {
    async findEntitiesByAlias(namespace, phrase) {
      if (phrase === 'unity') return [{ id: 'entity_unity', name: 'Unity' }];
      return [];
    },
    async expandFromChunks() { return { nodes: [], edges: [] }; },
    async expandFromEntities(namespace, entityIds) {
      expandFromEntitiesCalledWith = entityIds;
      return { nodes: [], edges: [] };
    },
  };
  await graphRetrieve({ queryText: 'Chi usa Unity?', namespace: 'ns', seedChunks: [] }, { graphRepo, maxHops: 2 });
  assert.deepEqual(expandFromEntitiesCalledWith, ['entity_unity']);
});

test('graphRetrieve non chiama expandFromEntities se nessuna entita e risolta nella query', async () => {
  let called = false;
  const graphRepo = {
    async findEntitiesByAlias() { return []; },
    async expandFromChunks() { return { nodes: [], edges: [] }; },
    async expandFromEntities() { called = true; return { nodes: [], edges: [] }; },
  };
  await graphRetrieve({ queryText: 'boh', namespace: 'ns', seedChunks: [] }, { graphRepo, maxHops: 2 });
  assert.equal(called, false);
});

test('graphRetrieve isola le contraddizioni tra gli archi restituiti', async () => {
  const graphRepo = {
    async findEntitiesByAlias() { return []; },
    async expandFromChunks() {
      return { nodes: [], edges: [{ type: 'CONTRADICTS', fromId: 'a', toId: 'b' }, { type: 'MENTIONS', fromId: 'c', toId: 'd' }] };
    },
    async expandFromEntities() { return { nodes: [], edges: [] }; },
  };
  const result = await graphRetrieve({ queryText: 'x', namespace: 'ns', seedChunks: [{ id: 'chunk_1' }] }, { graphRepo, maxHops: 2 });
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.contradictions[0].type, 'CONTRADICTS');
});
