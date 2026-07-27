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

test('un fallimento di lettura viene propagato (non convertito silenziosamente in nessun risultato)', async () => {
  const client = new FakeClient();
  client.nextResult = { ok: false, error: new Error('Neo4j non raggiungibile') };
  const repo = new GraphRepository(client);
  await assert.rejects(() => repo.findEntity('ns', 'entity_1'), /Neo4j non raggiungibile/);
  await assert.rejects(() => repo.findEntitiesByAlias('ns', 'unity'), /Neo4j non raggiungibile/);
  await assert.rejects(() => repo.findEntitiesByType('ns', 'technology'), /Neo4j non raggiungibile/);
  await assert.rejects(() => repo.findChunksByEntity('ns', 'entity_1'), /Neo4j non raggiungibile/);
  await assert.rejects(() => repo.findActiveDecisions('ns'), /Neo4j non raggiungibile/);
  await assert.rejects(() => repo.findSupersededDecisions('ns'), /Neo4j non raggiungibile/);
  await assert.rejects(() => repo.findContradictions('ns'), /Neo4j non raggiungibile/);
});

test('expandFromChunks propaga il fallimento del primo hop', async () => {
  const client = new FakeClient();
  client.nextResult = { ok: false, error: new Error('timeout') };
  const repo = new GraphRepository(client);
  await assert.rejects(() => repo.expandFromChunks('ns', ['chunk_1']), /timeout/);
});

test('expandFromChunks propaga il fallimento del secondo hop', async () => {
  const client = new FakeClient();
  let call = 0;
  client.run = async (cypher, params) => {
    call += 1;
    client.calls.push({ cypher, params });
    if (call === 1) return { ok: true, records: [] };
    return { ok: false, error: new Error('hop2 fallito') };
  };
  const repo = new GraphRepository(client);
  await assert.rejects(() => repo.expandFromChunks('ns', ['chunk_1'], { maxHops: 2 }), /hop2 fallito/);
});

test('upsertNode salva sia gli alias originali sia la loro forma normalizzata', async () => {
  const client = new FakeClient();
  client.nextResult = { ok: true, records: [fakeRecord({ n: fakeNode({ id: 'entity_1', namespace: 'ns' }) })] };
  const repo = new GraphRepository(client);
  await repo.upsertNode('Entity', { id: 'entity_1', namespace: 'ns', name: 'Neo4j', aliases: ['Neo4J', 'Neo Four J'] });
  assert.deepEqual(client.calls[0].params.aliasesNormalized, ['neo4j', 'neo four j']);
  assert.deepEqual(client.calls[0].params.aliases, ['Neo4J', 'Neo Four J']);
});

test('findEntitiesByAlias cerca in aliases_normalized, non in aliases grezzi', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  await repo.findEntitiesByAlias('ns', 'Neo4J');
  assert.match(client.calls[0].cypher, /aliases_normalized/);
  assert.doesNotMatch(client.calls[0].cypher, /\$normalized IN n\.aliases\b/);
});

test('findEntitiesByAlias con piu label cerca su tutte (non solo :Entity)', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  await repo.findEntitiesByAlias('ns', 'unity', { label: ['Entity', 'Project', 'Tool'] });
  assert.match(client.calls[0].cypher, /n:Entity OR n:Project OR n:Tool/);
});

test('expandFromEntities cerca i seed su tutte le label tipizzate, non solo :Entity', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  await repo.expandFromEntities('ns', ['project_1']);
  assert.match(client.calls[0].cypher, /seed:Entity OR seed:Project OR seed:Tool OR seed:Task OR seed:File OR seed:Session OR seed:Source/);
});

test('deleteNamespace elimina tutti i nodi del namespace a prescindere dalla label', async () => {
  const client = new FakeClient();
  const repo = new GraphRepository(client);
  const result = await repo.deleteNamespace('hearthfall');
  assert.equal(result.ok, true);
  assert.match(client.calls[0].cypher, /DETACH DELETE n/);
  assert.equal(client.calls[0].params.namespace, 'hearthfall');
});

test('deleteNamespace ritorna ok:false (non lancia) se la query fallisce', async () => {
  const client = new FakeClient();
  client.nextResult = { ok: false, error: new Error('boom') };
  const repo = new GraphRepository(client);
  const result = await repo.deleteNamespace('hearthfall');
  assert.equal(result.ok, false);
});
