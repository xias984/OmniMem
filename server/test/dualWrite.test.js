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

test('crea un arco Chunk-[:MENTIONS]->Entity per ogni entita dichiarata dall estrattore', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extraction = {
    ok: true,
    data: {
      entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: [] }],
      relations: [],
      decisions: [],
    },
  };
  await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );

  const entityGraphId = [...graphRepo.nodes.values()].find((n) => n.name === 'Unity WebGL').id;
  const cid = chunkId('hearthfall', 'chunk_248');
  const mentions = graphRepo.relations.get(`hearthfall::${cid}::MENTIONS::${entityGraphId}`);
  assert.ok(mentions, 'deve esistere un arco MENTIONS dal chunk verso l entita dichiarata');

  // L'entita deve essere recuperabile a partire dal chunk (findChunksByEntity)
  const chunksForEntity = await graphRepo.findChunksByEntity('hearthfall', entityGraphId);
  assert.equal(chunksForEntity.length, 1);
  assert.equal(chunksForEntity[0].id, cid);
});

test('crea MENTIONS anche per entita risolte al volo come endpoint di una relazione', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const extraction = {
    ok: true,
    data: {
      // 'Hearthfall' non e' dichiarata come entita esplicita: viene risolta
      // solo perche' compare come source di una relazione.
      entities: [],
      relations: [{ source: 'Hearthfall', relationship: 'USES', target: 'Unity WebGL', description: '', confidence: 0.9, evidence_chunk_id: 'chunk_248' }],
      decisions: [],
    },
  };
  await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );

  const cid = chunkId('hearthfall', 'chunk_248');
  const hearthfallNode = [...graphRepo.nodes.values()].find((n) => n.name === 'Hearthfall');
  assert.ok(hearthfallNode, 'l entita ad-hoc deve comunque essere stata creata');
  const mentions = graphRepo.relations.get(`hearthfall::${cid}::MENTIONS::${hearthfallNode.id}`);
  assert.ok(mentions, 'anche un entita risolta al volo deve avere un arco MENTIONS dal suo chunk di evidenza');
});

test('un fallimento nella scrittura strutturale (Memory) abortisce prima di chiamare l estrattore', async () => {
  const graphRepo = new InMemoryGraphRepo();
  let extractorCalled = false;
  const failingRepo = {
    ...graphRepo,
    upsertNode: async (label, props) => {
      if (label === 'Memory') return { ok: false, error: new Error('Neo4j non raggiungibile') };
      return graphRepo.upsertNode(label, props);
    },
    upsertRelation: graphRepo.upsertRelation.bind(graphRepo),
    findEntity: graphRepo.findEntity.bind(graphRepo),
  };
  const extractor = { async extract() { extractorCalled = true; return { ok: true, data: { entities: [], relations: [], decisions: [] } }; } };

  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo: failingRepo, extractor, thresholds, extractorVersion: 'v1' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'structural');
  assert.equal(extractorCalled, false, 'non deve nemmeno tentare l estrazione se la struttura portante fallisce');
});

test('un fallimento nella scrittura di un Chunk o del suo CHUNK_OF abortisce comunque il job', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const failingRepo = {
    ...graphRepo,
    upsertNode: graphRepo.upsertNode.bind(graphRepo),
    upsertRelation: async (props) => {
      if (props.type === 'CHUNK_OF') return { ok: false, error: new Error('scrittura CHUNK_OF fallita') };
      return graphRepo.upsertRelation(props);
    },
  };
  const extractor = fakeExtractor({ ok: true, data: { entities: [], relations: [], decisions: [] } });

  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo: failingRepo, extractor, thresholds, extractorVersion: 'v1' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'structural');
});

test('un fallimento nella scrittura di una entita dichiarata fa fallire il job (non solo la struttura)', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const failingRepo = {
    ...graphRepo,
    upsertNode: async (label, props) => {
      if (label === 'Entity') return { ok: false, error: new Error('upsert entita fallito') };
      return graphRepo.upsertNode(label, props);
    },
    upsertRelation: graphRepo.upsertRelation.bind(graphRepo),
    findEntity: graphRepo.findEntity.bind(graphRepo),
    findEntitiesByAlias: graphRepo.findEntitiesByAlias.bind(graphRepo),
    findEntitiesByType: graphRepo.findEntitiesByType.bind(graphRepo),
  };
  const extraction = {
    ok: true,
    data: {
      entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: [] }],
      relations: [],
      decisions: [],
    },
  };
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo: failingRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'partial');
});

test('un fallimento nella scrittura di un arco MENTIONS fa fallire il job', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const failingRepo = {
    ...graphRepo,
    upsertNode: graphRepo.upsertNode.bind(graphRepo),
    upsertRelation: async (props) => {
      if (props.type === 'MENTIONS') return { ok: false, error: new Error('upsert MENTIONS fallito') };
      return graphRepo.upsertRelation(props);
    },
    findEntity: graphRepo.findEntity.bind(graphRepo),
    findEntitiesByAlias: graphRepo.findEntitiesByAlias.bind(graphRepo),
    findEntitiesByType: graphRepo.findEntitiesByType.bind(graphRepo),
  };
  const extraction = {
    ok: true,
    data: {
      entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: [] }],
      relations: [],
      decisions: [],
    },
  };
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo: failingRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'partial');
});

test('un fallimento nella scrittura del nodo Decision fa fallire il job', async () => {
  const graphRepo = new InMemoryGraphRepo();
  const failingRepo = {
    ...graphRepo,
    upsertNode: async (label, props) => {
      if (label === 'Decision') return { ok: false, error: new Error('upsert Decision fallito') };
      return graphRepo.upsertNode(label, props);
    },
    upsertRelation: graphRepo.upsertRelation.bind(graphRepo),
    findEntity: graphRepo.findEntity.bind(graphRepo),
  };
  const extraction = {
    ok: true,
    data: {
      entities: [],
      relations: [],
      decisions: [{ statement: 'Nuova decisione', status: 'active', supersedes: null, confidence: 0.9, evidence_chunk_id: 'chunk_248' }],
    },
  };
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo: failingRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'partial');
});

test('anche con un fallimento parziale, le scritture successive continuano (non si interrompe a meta memory)', async () => {
  const graphRepo = new InMemoryGraphRepo();
  let entityUpsertCalls = 0;
  const failingRepo = {
    ...graphRepo,
    upsertNode: async (label, props) => {
      if (label === 'Entity') {
        entityUpsertCalls += 1;
        if (entityUpsertCalls === 1) return { ok: false, error: new Error('primo upsert entita fallito') };
      }
      return graphRepo.upsertNode(label, props);
    },
    upsertRelation: graphRepo.upsertRelation.bind(graphRepo),
    findEntity: graphRepo.findEntity.bind(graphRepo),
    findEntitiesByAlias: graphRepo.findEntitiesByAlias.bind(graphRepo),
    findEntitiesByType: graphRepo.findEntitiesByType.bind(graphRepo),
  };
  const extraction = {
    ok: true,
    data: {
      entities: [
        { temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: [] },
        { temporary_id: 'e2', name: 'PixiJS', type: 'technology', aliases: [] },
      ],
      relations: [],
      decisions: [],
    },
  };
  const result = await indexMemoryIntoGraph(
    { namespace: 'hearthfall', memory: baseMemory, chunks: baseChunks },
    { graphRepo: failingRepo, extractor: fakeExtractor(extraction), thresholds, extractorVersion: 'v1' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'partial');
  // La seconda entita (PixiJS) deve comunque essere stata scritta, nonostante
  // il fallimento sulla prima: il job fallisce nel complesso ma non si ferma.
  assert.ok([...graphRepo.nodes.values()].some((n) => n.name === 'PixiJS'));
});
