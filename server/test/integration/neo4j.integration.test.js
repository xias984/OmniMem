/**
 * Test di integrazione reali contro un'istanza Neo4j.
 * Si auto-escludono (skip esplicito, non silenzioso) se NEO4J_URI non e'
 * raggiungibile entro il timeout configurato: in CI/dev senza il servizio
 * Neo4j attivo questo e' il comportamento atteso e documentato.
 *
 * Per eseguirli davvero:
 *   docker compose up -d neo4j
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=... node --test test/integration/neo4j.integration.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { Neo4jClient } from '../../src/graph/neo4jClient.js';
import { GraphRepository } from '../../src/graph/graphRepository.js';

const cfg = loadConfig(process.env);
let client;
let available = false;

before(async () => {
  client = new Neo4jClient(cfg.neo4j);
  const health = await client.healthCheck();
  available = health.healthy;
  if (!available) {
    console.log(
      `[skip] test di integrazione Neo4j saltati: istanza non raggiungibile su ${cfg.neo4j.uri} (${health.error}). ` +
      'Avviare "docker compose up -d neo4j" per eseguirli.'
    );
  }
});

after(async () => {
  if (client) await client.close();
});

test('bootstrapSchema crea constraint e indici in idempotenza', { skip: () => !available }, async (t) => {
  if (!available) return t.skip('Neo4j non disponibile');
  const repo = new GraphRepository(client);
  const first = await repo.bootstrapSchema();
  const second = await repo.bootstrapSchema();
  assert.ok(first.every((r) => r.ok));
  assert.ok(second.every((r) => r.ok));
});

test('upsertNode e idempotente: stesso id non crea duplicati', { skip: () => !available }, async (t) => {
  if (!available) return t.skip('Neo4j non disponibile');
  const repo = new GraphRepository(client);
  const namespace = `test-ns-${Date.now()}`;
  await repo.upsertNode('Entity', { id: 'entity_test_1', namespace, type: 'technology', name: 'Unity' });
  await repo.upsertNode('Entity', { id: 'entity_test_1', namespace, type: 'technology', name: 'Unity' });

  const result = await client.run(
    'MATCH (n:Entity {namespace: $namespace, id: $id}) RETURN count(n) AS c',
    { namespace, id: 'entity_test_1' },
    { mode: 'READ' }
  );
  assert.equal(result.records[0].get('c').toNumber(), 1);
});

test('upsertRelation e idempotente e unisce le evidenze', { skip: () => !available }, async (t) => {
  if (!available) return t.skip('Neo4j non disponibile');
  const repo = new GraphRepository(client);
  const namespace = `test-ns-${Date.now()}`;
  await repo.upsertNode('Project', { id: 'project_test_1', namespace, type: 'project', name: 'Hearthfall' });
  await repo.upsertNode('Tool', { id: 'tool_test_1', namespace, type: 'tool', name: 'Unity' });

  await repo.upsertRelation({
    fromLabel: 'Project', fromId: 'project_test_1',
    toLabel: 'Tool', toId: 'tool_test_1',
    type: 'USES', namespace, confidence: 0.8, sourceChunkIds: ['chunk_a'], extractorVersion: 'v1',
  });
  await repo.upsertRelation({
    fromLabel: 'Project', fromId: 'project_test_1',
    toLabel: 'Tool', toId: 'tool_test_1',
    type: 'USES', namespace, confidence: 0.95, sourceChunkIds: ['chunk_b'], extractorVersion: 'v1',
  });

  const result = await client.run(
    'MATCH (:Project {namespace:$namespace, id:$fromId})-[r:USES]->(:Tool {namespace:$namespace, id:$toId}) RETURN count(r) AS c, r',
    { namespace, fromId: 'project_test_1', toId: 'tool_test_1' },
    { mode: 'READ' }
  );
  assert.equal(result.records[0].get('c').toNumber(), 1);
  const rel = result.records[0].get('r').properties;
  assert.equal(rel.confidence, 0.95);
  assert.deepEqual(new Set(rel.source_chunk_ids), new Set(['chunk_a', 'chunk_b']));
});

test('le query rispettano sempre il filtro namespace (isolamento)', { skip: () => !available }, async (t) => {
  if (!available) return t.skip('Neo4j non disponibile');
  const repo = new GraphRepository(client);
  const nsA = `test-iso-a-${Date.now()}`;
  const nsB = `test-iso-b-${Date.now()}`;
  await repo.upsertNode('Entity', { id: 'entity_shared_id', namespace: nsA, type: 'technology', name: 'Unity' });

  const foundInB = await repo.findEntity(nsB, 'entity_shared_id');
  const foundInA = await repo.findEntity(nsA, 'entity_shared_id');
  assert.equal(foundInB, null);
  assert.ok(foundInA);
});
