import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackfill } from '../src/graph/backfill.js';
import { InMemoryGraphRepo } from './support/inMemoryGraphRepo.js';

const thresholds = { automaticMergeThreshold: 0.93, possibleDuplicateThreshold: 0.8, semanticCompareEnabled: false, maxCandidates: 50 };
const emptyExtractor = { async extract() { return { ok: true, data: { entities: [], relations: [], decisions: [] } }; } };

function silentLogger() { return { log() {}, error() {} }; }

function makeItems(n, { topic = 'Hearthfall', sourceUrl = 'https://x', baseTs = 1000 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `chunk_${i}`,
    document: `testo ${i}`,
    metadata: { topic, source_url: sourceUrl, timestamp: baseTs + i },
  }));
}

function fakeFetcher(allItems, pageSize = 10) {
  return async ({ offset, limit }) => {
    const items = allItems.slice(offset, offset + Math.min(limit, pageSize));
    return { items, hasMore: offset + items.length < allItems.length };
  };
}

function memoryCheckpointStore() {
  let store = {};
  return {
    load: async () => store,
    save: async (_path, data) => { store = data; },
  };
}

test('processa tutti i chunk raggruppandoli per memory (topic+source_url+capture_id)', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const items = makeItems(5);
  const cp = memoryCheckpointStore();
  const summary = await runBackfill(
    { namespace: 'Hearthfall' },
    {
      fetchChunksPage: fakeFetcher(items),
      graphRepo, extractor: emptyExtractor, thresholds,
      loadCheckpoint: cp.load, saveCheckpoint: cp.save,
      checkpointPath: 'unused-in-test.json', logger: silentLogger(),
    }
  );
  assert.equal(summary.processedChunks, 5);
  assert.equal(summary.processedMemories, 1); // stesso source_url -> stessa memory
  assert.equal(summary.errors, 0);
});

test('dry-run non scrive nulla nel grafo ma conta correttamente', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const items = makeItems(5);
  const cp = memoryCheckpointStore();
  const summary = await runBackfill(
    { namespace: 'Hearthfall', dryRun: true },
    { fetchChunksPage: fakeFetcher(items), graphRepo, extractor: emptyExtractor, thresholds, loadCheckpoint: cp.load, saveCheckpoint: cp.save, checkpointPath: 'x', logger: silentLogger() }
  );
  assert.equal(summary.processedChunks, 5);
  assert.equal(graphRepo.nodes.size, 0);
});

test('rispetta il limite configurabile fermandosi in anticipo', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const items = makeItems(20, { sourceUrl: 'https://a' }).concat(); // stesso source per gruppo unico grande
  const cp = memoryCheckpointStore();
  const summary = await runBackfill(
    { namespace: 'Hearthfall', limit: 5 },
    { fetchChunksPage: fakeFetcher(items, 3), graphRepo, extractor: emptyExtractor, thresholds, loadCheckpoint: cp.load, saveCheckpoint: cp.save, checkpointPath: 'x', logger: silentLogger() }
  );
  assert.ok(summary.processedChunks <= 6, 'non deve sforare di molto il limite (arrotondato al batch/gruppo corrente)');
});

test('filtro temporale scarta chunk fuori range since/until', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const items = makeItems(5, { baseTs: 1000 }); // timestamp 1000..1004
  const cp = memoryCheckpointStore();
  const summary = await runBackfill(
    { namespace: 'Hearthfall', since: 1002, until: 1003 },
    { fetchChunksPage: fakeFetcher(items), graphRepo, extractor: emptyExtractor, thresholds, loadCheckpoint: cp.load, saveCheckpoint: cp.save, checkpointPath: 'x', logger: silentLogger() }
  );
  assert.equal(summary.skippedOutsideFilter, 3);
  assert.equal(summary.processedChunks, 2);
});

test('filtro namespace viene propagato al fetcher', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const seenNamespaces = [];
  const fetcher = async ({ namespace, offset, limit }) => {
    seenNamespaces.push(namespace);
    return { items: [], hasMore: false };
  };
  const cp = memoryCheckpointStore();
  await runBackfill(
    { namespace: 'MioProgetto' },
    { fetchChunksPage: fetcher, graphRepo, extractor: emptyExtractor, thresholds, loadCheckpoint: cp.load, saveCheckpoint: cp.save, checkpointPath: 'x', logger: silentLogger() }
  );
  assert.deepEqual(seenNamespaces, ['MioProgetto']);
});

test('riprende da checkpoint salvato dopo un interruzione', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const items = makeItems(10);
  let savedCheckpoint = { Hearthfall: { offset: 6 } };
  const cp = {
    load: async () => savedCheckpoint,
    save: async (_p, data) => { savedCheckpoint = data; },
  };
  const offsetsRequested = [];
  const fetcher = async ({ offset, limit }) => {
    offsetsRequested.push(offset);
    const page = items.slice(offset, offset + limit);
    return { items: page, hasMore: offset + page.length < items.length };
  };

  const summary = await runBackfill(
    { namespace: 'Hearthfall' },
    { fetchChunksPage: fetcher, graphRepo, extractor: emptyExtractor, thresholds, loadCheckpoint: cp.load, saveCheckpoint: cp.save, checkpointPath: 'x', logger: silentLogger() }
  );

  assert.equal(offsetsRequested[0], 6, 'deve riprendere dall offset salvato, non da zero');
  assert.equal(summary.processedChunks, 4); // chunk 6..9
});

test('rieseguire il backfill sugli stessi dati e idempotente', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const items = makeItems(3);
  const extractor = {
    async extract() {
      return {
        ok: true,
        data: { entities: [{ temporary_id: 'e1', name: 'Unity', type: 'technology', aliases: [] }], relations: [], decisions: [] },
      };
    },
  };
  async function run() {
    const cp = memoryCheckpointStore();
    return runBackfill(
      { namespace: 'Hearthfall' },
      { fetchChunksPage: fakeFetcher(items), graphRepo, extractor, thresholds, loadCheckpoint: cp.load, saveCheckpoint: cp.save, checkpointPath: 'x', logger: silentLogger() }
    );
  }
  await run();
  const nodeCountAfterFirst = graphRepo.nodes.size;
  await run();
  assert.equal(graphRepo.nodes.size, nodeCountAfterFirst);
});
