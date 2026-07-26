import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphRepository } from '../src/graph/graphRepository.js';

/** Client Neo4j finto: registra le chiamate e restituisce risposte pre-programmate. */
class FakeClient {
  constructor() {
    this.calls = [];
    this.nextResult = { ok: true, records: [] };
  }
  async run(cypher, params, opts) {
    this.calls.push({ cypher, params, opts });
    return this.nextResult;
  }
  async healthCheck() {
    return { healthy: true, latencyMs: 1 };
  }
}

function fakeRecord(obj) {
  const map = new Map(Object.entries(obj));
  return {
    get: (key) => map.get(key),
  };
}

function fakeNode(properties, labels = ['Entity']) {
  return { properties, labels };
}

function fakeRecordExpansion(nodeProps, relProps, relFrom, relTo, hop) {
  return fakeRecord({
    node: fakeNode(nodeProps),
    rel: { type: relProps.type, properties: relProps },
    relFrom,
    relTo,
    hop,
  });
}

test('upsertNode rifiuta label non presenti nello schema', async () => {
  const repo = new GraphRepository(new FakeClient());
  await assert.rejects(() => repo.upsertNode('NotALabel', { id: 'x', namespace: 'ns' }));
});

test('upsertNode richiede id e namespace', async () => {
  const repo = new GraphRepository(new FakeClient());
  await assert.rejects(() => repo.upsertNode('Entity', { name: 'foo' }));
});

test('upsertNode invia MERGE con proprieta corrette e metadata serializzato', async () => {
  const client = new FakeClient();
  client.nextResult = { ok: true, records: [fakeRecord({ n: fakeNode({ id: 'entity_1', namespace: 'ns', name: 'Unity' }) })] };
  const repo = new GraphRepository(client);

  const result = await repo.upsertNode('Entity', {
    id: 'entity_1',
    namespace: 'ns',
    type: 'technology',
    name: 'Unity',
    aliases: ['Unity Web'],
    metadata: { foo: 'bar' },
  });

  assert.equal(result.ok, true);
  assert.match(client.calls[0].cypher, /MERGE \(n:Entity/);
  assert.equal(client.calls[0].params.namespace, 'ns');
  assert.equal(client.calls[0].params.id, 'entity_1');
  assert.equal(typeof client.calls[0].params.metadataJson, 'string');
  assert.deepEqual(JSON.parse(client.calls[0].params.metadataJson), { foo: 'bar' });
  assert.deepEqual(client.calls[0].params.aliases, ['Unity Web']);
});

test('upsertRelation rifiuta relazioni senza evidenza (source_chunk_ids vuoto)', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  const result = await repo.upsertRelation({
    fromLabel: 'Project',
    fromId: 'p1',
    toLabel: 'Tool',
    toId: 't1',
    type: 'USES',
    namespace: 'ns',
    confidence: 0.9,
    sourceChunkIds: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /senza evidenza/);
  assert.equal(client.calls.length, 0);
});

test('upsertRelation rifiuta tipi di relazione non validi', async () => {
  const repo = new GraphRepository(new FakeClient());
  const result = await repo.upsertRelation({
    fromLabel: 'Project',
    fromId: 'p1',
    toLabel: 'Tool',
    toId: 't1',
    type: 'NOT_A_TYPE',
    namespace: 'ns',
    confidence: 0.9,
    sourceChunkIds: ['chunk_1'],
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /non valido/);
});

test('upsertRelation unisce source_chunk_ids esistenti con i nuovi e tiene la confidence massima', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);

  // findRelation (prima chiamata run) trova una relazione esistente
  let callIndex = 0;
  client.run = async (cypher, params) => {
    callIndex += 1;
    client.calls.push({ cypher, params });
    if (callIndex === 1) {
      return { ok: true, records: [fakeRecord({ r: fakeNode({ confidence: 0.5, source_chunk_ids: ['chunk_1'] }, []) })] };
    }
    return { ok: true, records: [fakeRecord({ r: fakeNode({}, []) })] };
  };

  await repo.upsertRelation({
    fromLabel: 'Project',
    fromId: 'p1',
    toLabel: 'Tool',
    toId: 't1',
    type: 'USES',
    namespace: 'ns',
    confidence: 0.9,
    sourceChunkIds: ['chunk_2'],
    extractorVersion: 'v1',
  });

  const upsertCall = client.calls[1];
  assert.deepEqual(new Set(upsertCall.params.sourceChunkIds), new Set(['chunk_1', 'chunk_2']));
  assert.equal(upsertCall.params.confidence, 0.9);
});

test('findEntitiesByAlias normalizza alias prima della query', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  await repo.findEntitiesByAlias('ns', 'Unity-Web!');
  assert.equal(client.calls[0].params.normalized, 'unity web');
  assert.equal(client.calls[0].opts.mode, 'READ');
});

test('expandFromChunks limita la profondita a 2 hop anche se richiesto di piu (mai piu di 2 query esplicite)', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  await repo.expandFromChunks('ns', ['chunk_1'], { maxHops: 10 });
  assert.equal(client.calls.length, 2, 'solo hop1 + hop2, mai una traversata illimitata');
});

test('expandFromChunks con maxHops=1 esegue una sola query (nessun secondo hop)', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  await repo.expandFromChunks('ns', ['chunk_1'], { maxHops: 1 });
  assert.equal(client.calls.length, 1);
});

test('expandFromChunks traccia la distanza (hop) minima e gli estremi reali di ogni relazione', async () => {
  const client = new FakeClient();
  let call = 0;
  client.run = async (cypher, params) => {
    call += 1;
    client.calls.push({ cypher, params });
    if (call === 1) {
      return {
        ok: true,
        records: [
          fakeRecordExpansion({ id: 'entity_1', name: 'Unity' }, { type: 'MENTIONS' }, 'chunk_1', 'entity_1', 1),
        ],
      };
    }
    return { ok: true, records: [] };
  };
  const repo = new GraphRepository(client);
  const result = await repo.expandFromChunks('ns', ['chunk_1'], { maxHops: 2 });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].hop, 1);
  assert.equal(result.edges[0].fromId, 'chunk_1');
  assert.equal(result.edges[0].toId, 'entity_1');
});

test('expandFromChunks ritorna vuoto senza interrogare il DB se non ci sono seed', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  const result = await repo.expandFromChunks('ns', []);
  assert.deepEqual(result, { nodes: [], edges: [] });
  assert.equal(client.calls.length, 0);
});

test('findSupersededDecisions espone chi ha sostituito la decisione', async () => {
  const client = new FakeClient();
  client.nextResult = {
    ok: true,
    records: [
      fakeRecord({
        d: fakeNode({ id: 'decision_old', status: 'superseded' }),
        supersededBy: [fakeNode({ id: 'decision_new', status: 'active' })],
      }),
    ],
  };
  const repo = new GraphRepository(client);
  const result = await repo.findSupersededDecisions('ns');
  assert.equal(result[0].id, 'decision_old');
  assert.equal(result[0].supersededBy[0].id, 'decision_new');
});

test('healthCheck delega al client', async () => {
  const repo = new GraphRepository(new FakeClient());
  const result = await repo.healthCheck();
  assert.equal(result.healthy, true);
});
