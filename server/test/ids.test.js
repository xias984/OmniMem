import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, canonicalKey, entityId, decisionId, memoryId, chunkId, relationId } from '../src/ids.js';

test('normalizeName collassa casing, spazi, trattini e punteggiatura', () => {
  assert.equal(normalizeName('Unity WebGL'), 'unity webgl');
  assert.equal(normalizeName('unity-webgl'), 'unity webgl');
  assert.equal(normalizeName('  Unity_WebGL  '), 'unity webgl');
  assert.equal(normalizeName('Unity, WebGL!'), 'unity webgl');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('normalizeName rimuove diacritici mantenendo il significato', () => {
  assert.equal(normalizeName('Perché è così?'), 'perche e cosi');
});

test('canonicalKey e entityId sono idempotenti per varianti equivalenti dello stesso nome', () => {
  const a = entityId('hearthfall', 'technology', 'Unity WebGL');
  const b = entityId('hearthfall', 'technology', 'unity-webgl');
  const c = entityId('hearthfall', 'technology', '  Unity_WebGL ');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('entityId distingue namespace ed entity_type diversi a parita di nome', () => {
  const inHearthfall = entityId('hearthfall', 'technology', 'Unity');
  const inOtherProject = entityId('other-project', 'technology', 'Unity');
  const asTool = entityId('hearthfall', 'tool', 'Unity');
  assert.notEqual(inHearthfall, inOtherProject);
  assert.notEqual(inHearthfall, asTool);
});

test('decisionId e stabile per lo stesso statement e namespace', () => {
  const a = decisionId('hearthfall', 'Unity WebGL sostituisce PixiJS');
  const b = decisionId('hearthfall', 'Unity WebGL sostituisce PixiJS');
  assert.equal(a, b);
});

test('memoryId e chunkId sono deterministici', () => {
  assert.equal(
    memoryId('hearthfall', 'https://chatgpt.com/x', 'cap1'),
    memoryId('hearthfall', 'https://chatgpt.com/x', 'cap1'),
  );
  assert.notEqual(
    memoryId('hearthfall', 'https://chatgpt.com/x', 'cap1'),
    memoryId('hearthfall', 'https://chatgpt.com/x', 'cap2'),
  );
  assert.equal(chunkId('ns', 'chroma_id_1'), chunkId('ns', 'chroma_id_1'));
});

test('relationId dipende dalla tripla (from, type, to)', () => {
  const r1 = relationId('e1', 'USES', 'e2');
  const r2 = relationId('e1', 'USES', 'e2');
  const r3 = relationId('e2', 'USES', 'e1');
  assert.equal(r1, r2);
  assert.notEqual(r1, r3);
});

test('canonicalKey usa default prudenti quando namespace/type mancanti', () => {
  assert.equal(canonicalKey(undefined, undefined, 'Foo'), 'default::entity::foo');
});
