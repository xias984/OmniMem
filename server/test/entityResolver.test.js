import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntity, stringSimilarity, cosineSimilarity } from '../src/graph/entityResolver.js';
import { entityId } from '../src/ids.js';

const thresholds = {
  automaticMergeThreshold: 0.93,
  possibleDuplicateThreshold: 0.8,
  semanticCompareEnabled: true,
  maxCandidates: 50,
};

function fakeGraphRepo({ exact = null, byAlias = [], byType = [] } = {}) {
  return {
    async findEntity() { return exact; },
    async findEntitiesByAlias() { return byAlias; },
    async findEntitiesByType() { return byType; },
  };
}

test('stringSimilarity: 1.0 per stringhe identiche a normalizzazione, minore altrimenti', () => {
  assert.equal(stringSimilarity('Unity WebGL', 'unity-webgl'), 1);
  assert.ok(stringSimilarity('Unity', 'Unity2D') < 1);
  assert.ok(stringSimilarity('Unity', 'Godot') < 0.5);
});

test('cosineSimilarity: 1.0 per vettori identici, 0 per vettori ortogonali', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('exact_match quando la chiave canonica esiste gia', async () => {
  const id = entityId('ns', 'technology', 'Unity WebGL');
  const repo = fakeGraphRepo({ exact: { id, name: 'Unity WebGL' } });
  const result = await resolveEntity({ namespace: 'ns', type: 'technology', name: 'Unity WebGL' }, { graphRepo: repo, thresholds });
  assert.equal(result.decision, 'exact_match');
  assert.equal(result.entityId, id);
});

test('automatic_merge quando il nome corrisponde a un alias noto', async () => {
  const repo = fakeGraphRepo({ byAlias: [{ id: 'entity_existing', name: 'Unity' }] });
  const result = await resolveEntity(
    { namespace: 'ns', type: 'technology', name: 'Unity Web', aliases: ['Unity Web'] },
    { graphRepo: repo, thresholds }
  );
  assert.equal(result.decision, 'automatic_merge');
  assert.equal(result.entityId, 'entity_existing');
});

test('automatic_merge per fuzzy match molto vicino (refuso)', async () => {
  const repo = fakeGraphRepo({ byType: [{ id: 'entity_unity', name: 'Unity WebGL' }] });
  const result = await resolveEntity(
    { namespace: 'ns', type: 'technology', name: 'Unity WebGl' }, // stesso testo, casing diverso su 'GL'
    { graphRepo: repo, thresholds }
  );
  assert.equal(result.decision, 'automatic_merge');
});

test('possible_duplicate per similarita moderata, senza merge automatico', async () => {
  const repo = fakeGraphRepo({ byType: [{ id: 'entity_unity', name: 'Unity' }] });
  const result = await resolveEntity(
    { namespace: 'ns', type: 'technology', name: 'Unify' }, // simile ma non identico
    { graphRepo: repo, thresholds: { ...thresholds, semanticCompareEnabled: false } }
  );
  assert.equal(result.decision, 'possible_duplicate');
  assert.equal(result.candidateEntityId, 'entity_unity');
});

test('new_entity quando non ci sono candidati plausibili', async () => {
  const repo = fakeGraphRepo({ byType: [{ id: 'entity_godot', name: 'Godot' }] });
  const result = await resolveEntity(
    { namespace: 'ns', type: 'technology', name: 'Unreal Engine' },
    { graphRepo: repo, thresholds }
  );
  assert.equal(result.decision, 'new_entity');
});

test('usa il confronto semantico solo nella fascia ambigua', async () => {
  const repo = fakeGraphRepo({ byType: [{ id: 'entity_x', name: 'Foobarqux' }] });
  let embedCalls = 0;
  const embed = async () => { embedCalls += 1; return [1, 0]; };
  await resolveEntity(
    { namespace: 'ns', type: 'technology', name: 'Completely Different Name' },
    { graphRepo: repo, thresholds, embed }
  );
  assert.equal(embedCalls, 0, 'non deve chiamare embed quando il fuzzy score e gia fuori dalla fascia ambigua');
});

test('nessun merge distruttivo: possible_duplicate non restituisce mai l id del candidato come entityId finale', async () => {
  const repo = fakeGraphRepo({ byType: [{ id: 'entity_unity', name: 'Unity' }] });
  const result = await resolveEntity(
    { namespace: 'ns', type: 'technology', name: 'Unify' },
    { graphRepo: repo, thresholds: { ...thresholds, semanticCompareEnabled: false } }
  );
  assert.notEqual(result.entityId, result.candidateEntityId);
});
