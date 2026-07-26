import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExtractionResult, validateEvidenceIntegrity } from '../src/graph/extractor/schema.js';

test('valida un output ben formato', () => {
  const result = validateExtractionResult({
    entities: [{ temporary_id: 'e1', name: 'Unity WebGL', type: 'technology', aliases: ['Unity Web'] }],
    relations: [
      { source: 'Hearthfall', relationship: 'USES', target: 'Unity WebGL', description: 'x', confidence: 0.92, evidence_chunk_id: 'chunk_248' },
    ],
    decisions: [
      { statement: 'Unity WebGL sostituisce PixiJS', status: 'active', supersedes: 'PixiJS', confidence: 0.94, evidence_chunk_id: 'chunk_248' },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.entities.length, 1);
});

test('rifiuta relationship non nell enum', () => {
  const result = validateExtractionResult({
    entities: [],
    relations: [{ source: 'a', relationship: 'INVENTED_TYPE', target: 'b', confidence: 0.5, evidence_chunk_id: 'c1' }],
    decisions: [],
  });
  assert.equal(result.ok, false);
});

test('rifiuta confidence fuori range [0,1]', () => {
  const result = validateExtractionResult({
    entities: [],
    relations: [{ source: 'a', relationship: 'USES', target: 'b', confidence: 1.5, evidence_chunk_id: 'c1' }],
    decisions: [],
  });
  assert.equal(result.ok, false);
});

test('rifiuta relazione senza evidence_chunk_id', () => {
  const result = validateExtractionResult({
    entities: [],
    relations: [{ source: 'a', relationship: 'USES', target: 'b', confidence: 0.5 }],
    decisions: [],
  });
  assert.equal(result.ok, false);
});

test('rifiuta status decisione non ammesso', () => {
  const result = validateExtractionResult({
    entities: [],
    relations: [],
    decisions: [{ statement: 'x', status: 'maybe', confidence: 0.5, evidence_chunk_id: 'c1' }],
  });
  assert.equal(result.ok, false);
});

test('accetta liste vuote (nessuna conoscenza estratta)', () => {
  const result = validateExtractionResult({ entities: [], relations: [], decisions: [] });
  assert.equal(result.ok, true);
});

test('applica default sensati per campi opzionali', () => {
  const result = validateExtractionResult({
    entities: [{ temporary_id: 'e1', name: 'X', type: 'technology' }],
    relations: [],
    decisions: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.entities[0].aliases, []);
});

test('validateEvidenceIntegrity rifiuta evidence_chunk_id inventati', () => {
  const data = {
    entities: [],
    relations: [{ source: 'a', relationship: 'USES', target: 'b', description: '', confidence: 0.5, evidence_chunk_id: 'chunk_999' }],
    decisions: [],
  };
  const result = validateEvidenceIntegrity(data, ['chunk_1', 'chunk_2']);
  assert.equal(result.ok, false);
});

test('validateEvidenceIntegrity accetta evidence_chunk_id noti', () => {
  const data = {
    entities: [],
    relations: [{ source: 'a', relationship: 'USES', target: 'b', description: '', confidence: 0.5, evidence_chunk_id: 'chunk_1' }],
    decisions: [],
  };
  const result = validateEvidenceIntegrity(data, ['chunk_1', 'chunk_2']);
  assert.equal(result.ok, true);
});
