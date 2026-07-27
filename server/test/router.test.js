import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuery, usesGraph, CATEGORY_STRATEGY } from '../src/retrieval/router.js';

test('classifica correttamente le categorie principali (italiano)', () => {
  assert.equal(classifyQuery('Perché è stata scartata la soluzione precedente?').category, 'causal');
  assert.equal(classifyQuery('Quale decisione ha sostituito quella vecchia?').category, 'decision');
  assert.equal(classifyQuery('Da quali task dipende questa attività?').category, 'dependency');
  assert.equal(classifyQuery('Quando è cambiata questa architettura nel tempo?').category, 'temporal');
  assert.equal(classifyQuery('Esistono memorie in contraddizione?').category, 'contradiction');
  assert.equal(classifyQuery('Dammi una panoramica generale del progetto').category, 'global_summary');
  assert.equal(classifyQuery('Cosa è collegato a Unity WebGL?').category, 'relational');
});

test('fallback sicuro su semantic per query generiche o vuote', () => {
  assert.equal(classifyQuery('Quale tecnologia è attualmente usata dal progetto?').category, 'semantic');
  assert.equal(classifyQuery('').category, 'semantic');
  assert.equal(classifyQuery(undefined).category, 'semantic');
});

test('ogni categoria ha una strategia definita e coerente con la specifica', () => {
  assert.equal(CATEGORY_STRATEGY.semantic, 'vector');
  assert.equal(CATEGORY_STRATEGY.relational, 'vector+graph');
  assert.equal(CATEGORY_STRATEGY.causal, 'vector+graph');
  assert.equal(CATEGORY_STRATEGY.temporal, 'graph+vector');
  assert.equal(CATEGORY_STRATEGY.decision, 'graph+vector');
  assert.equal(CATEGORY_STRATEGY.dependency, 'graph+vector');
  assert.equal(CATEGORY_STRATEGY.contradiction, 'graph+vector');
  assert.equal(CATEGORY_STRATEGY.global_summary, 'vector');
});

test('usesGraph riconosce solo le strategie che coinvolgono il grafo', () => {
  assert.equal(usesGraph('vector'), false);
  assert.equal(usesGraph('vector+graph'), true);
  assert.equal(usesGraph('graph+vector'), true);
});

test('la classificazione non richiede alcuna chiamata di rete/LLM (funzione pura sincrona)', () => {
  const result = classifyQuery('test');
  assert.equal(typeof result.category, 'string');
});
