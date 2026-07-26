import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hybridScore, computeGraphProximity, computeRecency } from '../src/retrieval/scoring.js';

const weights = { vectorSimilarity: 0.45, graphProximity: 0.20, relationConfidence: 0.15, recency: 0.10, namespaceRelevance: 0.10 };
const penalties = {
  outOfNamespace: 1.0, missingEvidence: 0.5, supersededDecision: 0.4, ambiguousEntity: 0.2,
  lowConfidence: 0.2, highGraphDistance: 0.15, duplicateContent: 1.0,
};

test('computeGraphProximity decresce con la distanza e vale 1 a hop 0', () => {
  assert.equal(computeGraphProximity(0), 1);
  assert.ok(computeGraphProximity(1) < 1);
  assert.ok(computeGraphProximity(2) < computeGraphProximity(1));
  assert.equal(computeGraphProximity(null), 0);
});

test('computeRecency vale 1 per timestamp attuale e decresce nel tempo', () => {
  const now = 1_700_000_000_000;
  assert.equal(computeRecency(now, { now }), 1);
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  assert.ok(computeRecency(oneYearAgo, { now, halfLifeDays: 90 }) < 0.1);
  assert.equal(computeRecency(0, { now }), 0);
});

test('hybridScore applica i pesi configurati senza pesi hardcoded', () => {
  const components = { vectorSimilarity: 1, graphProximity: 0, relationConfidence: 0, recency: 0, namespaceRelevance: 0 };
  const score = hybridScore(components, {}, weights, penalties);
  assert.equal(score, 0.45);
});

test('hybridScore somma i contributi pesati di tutte le componenti', () => {
  const components = { vectorSimilarity: 1, graphProximity: 1, relationConfidence: 1, recency: 1, namespaceRelevance: 1 };
  const score = hybridScore(components, {}, weights, penalties);
  assert.equal(Math.round(score * 100) / 100, 1);
});

test('hybridScore applica le penalita configurate e non scende sotto zero', () => {
  const components = { vectorSimilarity: 0.1, graphProximity: 0, relationConfidence: 0, recency: 0, namespaceRelevance: 0 };
  const score = hybridScore(components, { outOfNamespace: true, duplicateContent: true }, weights, penalties);
  assert.equal(score, 0); // penalita' totali (2.0) >> punteggio base, clampato a 0
});

test('hybridScore: decisione superata riceve penalita specifica', () => {
  const components = { vectorSimilarity: 0.8, graphProximity: 0.5, relationConfidence: 0.9, recency: 0.5, namespaceRelevance: 1 };
  const withoutPenalty = hybridScore(components, {}, weights, penalties);
  const withPenalty = hybridScore(components, { supersededDecision: true }, weights, penalties);
  assert.ok(withPenalty < withoutPenalty);
  assert.equal(Math.round((withoutPenalty - withPenalty) * 100) / 100, penalties.supersededDecision);
});
