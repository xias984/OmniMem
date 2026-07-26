import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexMemoryIntoGraph } from '../src/graph/dualWrite.js';
import { InMemoryGraphRepo } from './support/inMemoryGraphRepo.js';
import { memoryId, chunkId, decisionId } from '../src/ids.js';

const thresholds = {
  automaticMergeThreshold: 0.93,
  possibleDuplicateThreshold: 0.8,
  semanticCompareEnabled: false,
  maxCandidates: 50,
};

function fakeExtractor(result) {
  return { async extract() { return result; } };
}

const baseMemory = { sourceUrl: 'https://chatgpt.com/x', captureId: 'cap1', platform: 'ChatGPT', topic: 'Hearthfall' };
const baseChunks = [{ id: 'chunk_248', text: 'Hearthfall usa Unity WebGL invece di PixiJS', timestamp: 1000 }];

test('scrive sempre la struttura Memory/Chunk/CHUNK_OF anche con estrazione vuota', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: fakeExtractor({ ok: true, data: { entities: [], relations: [], decisions: [] } }), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, true);
  const memGraphId = memoryId('hearthfall', baseMemory.sourceUrl, baseMemory.captureId);
  const cid = chunkId('hearthfall', 'chunk_248');
  assert.ok(await graphRepo.findEntity('hearthfall', memGraphId, 'Memory'));
  assert.ok(await graphRepo.findEntity('hearthfall', cid, 'Chunk'));
  assert.equal(graphRepo.relations.get(`hearthfall::${cid}::CHUNK_OF::${memGraphId}`).type, 'CHUNK_OF');
});

test('la struttura resta salvata anche se l estrazione fallisce', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: fakeExtractor({ ok: false, error: new Error('output malformato') }), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'extract');
  const cid = chunkId('hearthfall', 'chunk_248');
  assert.ok(await graphRepo.findEntity('hearthfall', cid, 'Chunk'), 'il chunk deve comunque esistere nel grafo');
});

test('crea entita, relazioni e decisioni da un estrazione ben formata', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extraction = {
    ok: true,
    data: {
      entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: ['Unity Web'] }],
      relations: [{ source: 'Hearthfall', relationship: 'USES', target: 'Unity WebGL', description: 'x', confidence: 0.92, evidence_chunk_id: 'chunk_248' }],
      decisions: [{ statement: 'Unity WebGL sostituisce PixiJS', status: 'active', supersedes: null, confidence: 0.94, evidence_chunk_id: 'chunk_248' }],
    },
  };
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.stats.entities_extracted, 1);
  assert.equal(result.stats.relations_extracted, 1);
  assert.equal(result.stats.decisions_extracted, 1);

  const did = decisionId('hearthfall', 'Unity WebGL sostituisce PixiJS');
  const decisionNode = await graphRepo.findEntity('hearthfall', did, 'Decision');
  assert.equal(decisionNode.status, 'active');

  // 'Hearthfall' non era tra le entita' dichiarate: deve essere creato al volo come tipo 'other'
  const relations = [...graphRepo.relations.values()].filter((r) => r.type === 'USES');
  assert.equal(relations.length, 1);
});

test('indicizzare due volte lo stesso contenuto e idempotente (nessun duplicato)', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extraction = {
    ok: true,
    data: {
      entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: [] }],
      relations: [{ source: 'Hearthfall', relationship: 'USES', target: 'Unity WebGL', description: '', confidence: 0.9, evidence_chunk_id: 'chunk_248' }],
      decisions: [],
    },
  };
  const input = { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks };
  const deps = { graphRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' };

  await indexMemoryIntoGraph(input, deps);
  const nodesAfterFirst = graphRepo.nodes.size;
  const relationsAfterFirst = graphRepo.relations.size;

  await indexMemoryIntoGraph(input, deps);
  assert.equal(graphRepo.nodes.size, nodesAfterFirst);
  assert.equal(graphRepo.relations.size, relationsAfterFirst);
});

test('scarta (difesa in profondita) relazioni con evidence_chunk_id fuori dal batch corrente', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extraction = {
    ok: true,
    data: {
      entities: [],
      relations: [{ source: 'a', relationship: 'USES', target: 'b', description: '', confidence: 0.9, evidence_chunk_id: 'chunk_NON_NEL_BATCH' }],
      decisions: [],
    },
  };
  const result = await indexMemoryIntoGraph(
    { namespace: 'ns', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.stats.relations_extracted, 0);
});

test('una decisione che ne supera un altra crea SUPERSEDES e marca la vecchia come superseded', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extractorFirst = fakeExtractor({
    ok: true,
    data: { entities: [], relations: [], decisions: [{ statement: 'PixiJS per il prototipo', status: 'active', supersedes: null, confidence: 0.9, evidence_chunk_id: 'chunk_248' }] },
  });
  await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: extractorFirst, thresholds, extractorVersion: 'v1' }
  );

  const extractorSecond = fakeExtractor({
    ok: true,
    data: { entities: [], relations: [], decisions: [{ statement: 'Unity WebGL sostituisce PixiJS', status: 'active', supersedes: 'PixiJS per il prototipo', confidence: 0.94, evidence_chunk_id: 'chunk_248' }] },
  });
  await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: extractorSecond, thresholds, extractorVersion: 'v1' }
  );

  const oldId = decisionId('hearthfall', 'PixiJS per il prototipo');
  const newId = decisionId('hearthfall', 'Unity WebGL sostituisce PixiJS');
  const oldDecision = await graphRepo.findEntity('hearthfall', oldId, 'Decision');
  assert.equal(oldDecision.status, 'superseded');
  const supersedesRel = graphRepo.relations.get(`hearthfall::${newId}::SUPERSEDES::${oldId}`);
  assert.ok(supersedesRel);
});

test('supersedes verso una decisione mai vista crea uno stub storico invece di fallire', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extractor = fakeExtractor({
    ok: true,
    data: { entities: [], relations: [], decisions: [{ statement: 'Nuova decisione', status: 'active', supersedes: 'Decisione mai indicizzata prima', confidence: 0.9, evidence_chunk_id: 'chunk_248' }] },
  });
  await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor, thresholds, extractorVersion: 'v1' }
  );
  const stubId = decisionId('hearthfall', 'Decisione mai indicizzata prima');
  const stub = await graphRepo.findEntity('hearthfall', stubId, 'Decision');
  assert.equal(stub.status, 'historical');
  assert.equal(stub.metadata.stub, true);
});
