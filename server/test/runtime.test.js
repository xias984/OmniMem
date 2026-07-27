import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphRuntime } from '../src/graph/runtime.js';
import { resetSharedNeo4jClient } from '../src/graph/neo4jClient.js';
import { loadConfig } from '../src/config.js';

test('con tutti i flag GraphRAG disattivati, il repository e la cancellazione del namespace restano comunque disponibili', async () => {
  resetSharedNeo4jClient();
  const cfg = loadConfig({}); // OMNIMEM_GRAPHRAG_ENABLED/_GRAPH_INDEXING_ENABLED/_GRAPH_SHADOW_MODE assenti -> tutti false
  const runtime = createGraphRuntime(cfg);
  try {
    assert.equal(runtime.enabled, false);
    assert.equal(runtime.indexingEnabled, false);
    assert.equal(runtime.shadowMode, false);
    // Prima del fix, con tutti i flag spenti veniva ritornato un runtime
    // "no-op puro" con graphRepo:null: un topic cancellato non veniva mai
    // ripulito nel grafo, anche se popolato in un run precedente.
    assert.ok(runtime.graphRepo, 'il repository grafo deve esistere anche a GraphRAG completamente disattivato');
    assert.equal(typeof runtime.enqueueNamespaceDeletion, 'function');
  } finally {
    await runtime.close();
  }
});

test('enqueueIndexing resta un no-op quando l indicizzazione e disattivata (nessun impatto sul comportamento esistente)', async () => {
  resetSharedNeo4jClient();
  const cfg = loadConfig({});
  const runtime = createGraphRuntime(cfg);
  try {
    assert.doesNotThrow(() => runtime.enqueueIndexing({ namespace: 'ns', memory: {}, chunks: [] }));
  } finally {
    await runtime.close();
  }
});

test('costruire il runtime non tenta alcuna connessione di rete (nessun impatto sull avvio del server)', async () => {
  resetSharedNeo4jClient();
  const cfg = loadConfig({});
  const start = Date.now();
  const runtime = createGraphRuntime(cfg);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, 'la costruzione deve essere sincrona e istantanea (connessione lazy)');
  await runtime.close();
});
